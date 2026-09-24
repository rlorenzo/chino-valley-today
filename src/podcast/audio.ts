// Renders a podcast episode from a two-host transcript via Gemini 3.8
// multi-speaker TTS (Interactions API), chunking long sections, caching per-chunk audio, and muxing the result
// with ffmpeg. Ported from the proven prototype at
// scratchpad/podcast/render-gemini.mjs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Agent, fetch as undiciFetch } from "undici";
import { SITE_ORIGIN } from "../pipeline/site-url.ts";
import { ROOT } from "../store.ts";

try {
	process.loadEnvFile(join(ROOT, ".env"));
} catch {
	// no .env yet — fine for everything except a live render
}

const agent = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

// 3.8 TTS reads input text verbatim, so direction rides in each turn's
// speech_metadata annotation rather than a spoken preamble.
const STYLE =
	"calm, warm public-radio local news host; steady, unhurried pace; no dramatization";
const MAX_CHUNK_CHARS = 3500;
const MIN_REQUEST_GAP_MS = 21_000; // free tier: 3 requests/minute
const MAX_DURATION_SEC = 660; // 11 min cap; caller holds the post past this
const SAMPLE_RATE = 24_000; // Gemini TTS: PCM s16le, mono

export type Speaker = "Maya" | "Dan";

export interface Turn {
	speaker: Speaker;
	text: string;
}

export interface Section {
	title: string;
	turns: Turn[];
}

export interface Chapter {
	title: string;
	startSec: number;
}

export interface RenderEpisodeOpts {
	slug: string;
	transcriptMd: string;
	title: string;
}

export interface RenderEpisodeResult {
	url: string;
	bytes: number;
	durationSec: number;
	chapters: Chapter[];
}

const HEADING_RE = /^## (.+)$/;
const TURN_RE = /^\*\*(Maya|Dan):\*\* (.+)$/;
const LINK_RE = /\[[^\]]*\]\([^)]*\)/g;

// `## <Section>` headings start a section; `**Maya:** text` / `**Dan:** text`
// are speaker turns. Markdown links in a turn are stripped (citations, not
// speech) and whitespace collapsed. Anything else non-blank is a transcript
// bug, not audio to synthesize.
export function parseTranscript(transcriptMd: string): Section[] {
	const sections: Section[] = [];
	for (const raw of transcriptMd.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const heading = HEADING_RE.exec(line);
		if (heading) {
			sections.push({ title: heading[1], turns: [] });
			continue;
		}
		const turn = TURN_RE.exec(line);
		if (turn) {
			const section = sections.at(-1);
			if (!section) {
				throw new Error(
					`turn before any section heading: ${line.slice(0, 60)}`,
				);
			}
			const text = turn[2].replace(LINK_RE, "").replace(/\s+/g, " ").trim();
			section.turns.push({ speaker: turn[1] as Speaker, text });
			continue;
		}
		throw new Error(`unrecognized transcript line: ${line.slice(0, 60)}`);
	}
	return sections;
}

// Splits a section's turns into request-sized chunks (~3 min of audio each),
// never mid-turn. Each returned string is the `Speaker: text` lines for one
// request, newline-joined.
export function chunkSection(
	turns: Turn[],
	maxChars = MAX_CHUNK_CHARS,
): string[] {
	const chunks: string[][] = [[]];
	for (const t of turns) {
		const line = `${t.speaker}: ${t.text}`;
		let current = chunks[chunks.length - 1];
		if (
			current.length &&
			current.join("\n").length + 1 + line.length > maxChars
		) {
			chunks.push([]);
			current = chunks[chunks.length - 1];
		}
		current.push(line);
	}
	return chunks.map((c) => c.join("\n"));
}

// Section start/end times (seconds) from each section's cumulative PCM byte
// count, in order.
export function chapterTimes(
	sections: { title: string; bytes: number }[],
): { title: string; startSec: number; endSec: number }[] {
	let elapsed = 0;
	return sections.map(({ title, bytes }) => {
		const startSec = elapsed;
		elapsed += bytes / 2 / SAMPLE_RATE;
		return { title, startSec, endSec: elapsed };
	});
}

export type RetryDecision = "retry" | "switch" | "throw";

// Pure retry/failover decision for a 429/403/5xx TTS response. Anything else
// isn't retryable. A per-day quota error switches to an unused backup key if
// one exists; otherwise it's fatal. Everything else backs off up to 6 tries.
export function decideRetry(opts: {
	status: number;
	body: string;
	attempt: number;
	hasBackup: boolean;
	onBackup: boolean;
}): RetryDecision {
	const { status, body, attempt, hasBackup, onBackup } = opts;
	if (status !== 429 && status !== 403 && status < 500) return "throw";
	const daily = /PerDay/.test(body);
	if (daily && hasBackup && !onBackup) return "switch";
	if (!daily && attempt <= 6) return "retry";
	return "throw";
}

function cacheDir(): string {
	return join(ROOT, "data", "podcast-cache");
}

function cacheKey(
	model: string,
	voiceMaya: string,
	voiceDan: string,
	chunkText: string,
): string {
	return createHash("sha256")
		.update(`${model} ${voiceMaya} ${voiceDan} ${chunkText}`)
		.digest("hex");
}

function runFfmpeg(rawPath: string, ffmetaPath: string, outPath: string): void {
	execFileSync("ffmpeg", [
		"-y",
		"-f",
		"s16le",
		"-ar",
		String(SAMPLE_RATE),
		"-ac",
		"1",
		"-i",
		rawPath,
		"-i",
		ffmetaPath,
		"-map_metadata",
		"1",
		"-map",
		"0:a",
		"-af",
		"loudnorm=I=-16:TP=-1.5:LRA=11",
		"-b:a",
		"64k",
		"-id3v2_version",
		"3",
		outPath,
	]);
}

function runFfprobe(path: string): number {
	const out = execFileSync("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"csv=p=0",
		path,
	]);
	return Number(out.toString().trim());
}

/**
 * Moves a rendered episode's MP3 and chapters sidecar into the public asset
 * directory. Called only after the post is committed to `published`, so the
 * two things a listener can reach — the post and the recording — appear
 * together. Copies rather than moves: the cache copy is what a re-run reuses.
 */
export function publishEpisodeAudio(slug: string): void {
	const audioDir = join(ROOT, "site", "public", "audio");
	mkdirSync(audioDir, { recursive: true });
	for (const name of [`${slug}.mp3`, `${slug}.chapters.json`]) {
		copyFileSync(join(cacheDir(), name), join(audioDir, name));
	}
}

export async function renderEpisode(
	opts: RenderEpisodeOpts,
): Promise<RenderEpisodeResult> {
	const sections = parseTranscript(opts.transcriptMd);
	const model = process.env.CVT_MODEL_TTS ?? "gemini-3.8-flash-tts";
	const voices = {
		Maya: process.env.CVT_TTS_VOICE_MAYA ?? "Kore",
		Dan: process.env.CVT_TTS_VOICE_DAN ?? "Charon",
	};
	const keys = [
		process.env.GEMINI_API_KEY,
		process.env.GEMINI_API_KEY_BACKUP,
	].filter((k): k is string => Boolean(k));
	if (!keys.length) {
		throw new Error(
			"GEMINI_API_KEY is not set — put it (and optionally GEMINI_API_KEY_BACKUP) in .env",
		);
	}
	let keyIdx = 0;
	let lastReq = 0;

	async function pace(): Promise<void> {
		const wait = lastReq + MIN_REQUEST_GAP_MS - Date.now();
		if (wait > 0) await new Promise((r) => setTimeout(r, wait));
		lastReq = Date.now();
	}

	async function synth(chunkText: string): Promise<Buffer> {
		// chunkSection's `Speaker: text` lines back into one annotated item per turn.
		const content = chunkText.split("\n").map((line) => {
			const sep = line.indexOf(": ");
			return {
				type: "text",
				text: line.slice(sep + 2),
				annotations: [
					{
						type: "speech_metadata",
						speaker: line.slice(0, sep),
						style: STYLE,
					},
				],
			};
		});
		const body = {
			model,
			input: [{ type: "user_input", content }],
			response_format: {
				type: "audio",
				mime_type: "audio/l16",
				sample_rate: SAMPLE_RATE,
			},
			generation_config: {
				speech_config: {
					mode: "conversational",
					speakers: [
						{ speaker: "Maya", voice: voices.Maya },
						{ speaker: "Dan", voice: voices.Dan },
					],
				},
			},
		};
		for (let attempt = 1; ; attempt++) {
			await pace();
			let res: Awaited<ReturnType<typeof undiciFetch>>;
			try {
				res = await undiciFetch(
					"https://generativelanguage.googleapis.com/v1beta/interactions",
					{
						method: "POST",
						headers: {
							"x-goog-api-key": keys[keyIdx],
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
						dispatcher: agent,
					},
				);
			} catch (err) {
				if (attempt <= 5) continue;
				throw err;
			}
			if (res.status === 429 || res.status === 403 || res.status >= 500) {
				const text = await res.text();
				const decision = decideRetry({
					status: res.status,
					body: text,
					attempt,
					hasBackup: keys.length > 1,
					onBackup: keyIdx > 0,
				});
				if (decision === "switch") {
					keyIdx++;
					lastReq = 0;
					continue;
				}
				if (decision === "retry") {
					await new Promise((r) => setTimeout(r, attempt * 20_000));
					continue;
				}
				throw new Error(`${res.status} ${text.slice(0, 300)}`);
			}
			if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
			const json = (await res.json()) as {
				steps?: Array<{ content?: Array<{ type?: string; data?: string }> }>;
			};
			const audio = json.steps
				?.flatMap((st) => st.content ?? [])
				.find((c) => c.type === "audio" && c.data);
			if (!audio?.data) {
				throw new Error(
					`no audio in response: ${JSON.stringify(json).slice(0, 400)}`,
				);
			}
			return Buffer.from(audio.data, "base64");
		}
	}

	mkdirSync(cacheDir(), { recursive: true });
	const sectionBytes: { title: string; bytes: number }[] = [];
	const pcmChunks: Buffer[] = [];
	for (const section of sections) {
		let bytes = 0;
		for (const chunkText of chunkSection(section.turns)) {
			const cachePath = join(
				cacheDir(),
				`${cacheKey(model, voices.Maya, voices.Dan, chunkText)}.raw`,
			);
			// Read first and fall back on a miss, rather than exists-then-read:
			// one call, no window between the check and the use.
			let pcm: Buffer;
			try {
				pcm = readFileSync(cachePath);
			} catch (err) {
				// Only a missing file is a cache miss. Any other read failure is a
				// storage problem, and spending a quota-limited request on it would
				// hide that behind a write to the same broken path.
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				pcm = await synth(chunkText);
				writeFileSync(cachePath, pcm);
			}
			pcmChunks.push(pcm);
			bytes += pcm.length;
		}
		sectionBytes.push({ title: section.title, bytes });
	}

	const chapters = chapterTimes(sectionBytes);
	const rawPath = join(cacheDir(), `${opts.slug}.raw`);
	const ffmetaPath = join(cacheDir(), `${opts.slug}.ffmeta`);
	writeFileSync(rawPath, Buffer.concat(pcmChunks));
	writeFileSync(
		ffmetaPath,
		`;FFMETADATA1\ntitle=${opts.title}\nartist=Chino Valley Today\nalbum=Chino Valley Today, the Week in Review\n${chapters
			.map(
				(c) =>
					`[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.startSec * 1000)}\nEND=${Math.round(c.endSec * 1000)}\ntitle=${c.title}\n`,
			)
			.join("")}`,
	);

	// Rendered into the private cache dir, not site/public/audio: every astro
	// build copies that directory into the release (deploy/README.md), so an
	// episode a human rejects while the render is running would be served at
	// /audio/<slug>.mp3 anyway. publishEpisodeAudio promotes it once the post
	// is really published.
	const outPath = join(cacheDir(), `${opts.slug}.mp3`);
	runFfmpeg(rawPath, ffmetaPath, outPath);

	const durationSec = Math.round(runFfprobe(outPath));
	if (durationSec > MAX_DURATION_SEC) {
		throw new Error(
			`episode is ${durationSec}s, over the ${MAX_DURATION_SEC}s (11 min) cap`,
		);
	}

	const chaptersOut = chapters.map((c) => ({
		startTime: Math.round(c.startSec),
		title: c.title,
	}));
	writeFileSync(
		join(cacheDir(), `${opts.slug}.chapters.json`),
		JSON.stringify({ version: "1.2.0", chapters: chaptersOut }, null, 2),
	);

	return {
		url: `${SITE_ORIGIN}/audio/${opts.slug}.mp3`,
		bytes: statSync(outPath).size,
		durationSec,
		chapters: chaptersOut.map((c) => ({
			title: c.title,
			startSec: c.startTime,
		})),
	};
}
