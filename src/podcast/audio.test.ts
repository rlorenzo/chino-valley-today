import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT } from "../store.ts";
import {
	chapterTimes,
	chunkSection,
	decideRetry,
	parseTranscript,
	publishEpisodeAudio,
} from "./audio.ts";

describe("parseTranscript", () => {
	test("parses sections and turns, stripping links and collapsing whitespace", () => {
		const md = `## Opening

**Maya:** Good morning,   Chino Valley. [source](https://example.com/a)
**Dan:** Big week ahead. [agenda](https://example.com/b) [also this](https://example.com/c)

## Sign-off

**Maya:** See you next week.
`;
		const sections = parseTranscript(md);
		assert.equal(sections.length, 2);
		assert.equal(sections[0].title, "Opening");
		assert.deepEqual(sections[0].turns, [
			{ speaker: "Maya", text: "Good morning, Chino Valley." },
			{ speaker: "Dan", text: "Big week ahead." },
		]);
		assert.equal(sections[1].title, "Sign-off");
		assert.deepEqual(sections[1].turns, [
			{ speaker: "Maya", text: "See you next week." },
		]);
	});

	test("ignores blank lines", () => {
		const sections = parseTranscript("## Opening\n\n\n**Maya:** hi\n\n");
		assert.equal(sections[0].turns.length, 1);
	});

	test("throws on a non-blank line that is neither a heading nor a turn", () => {
		assert.throws(
			() => parseTranscript("## Opening\nsome stray narration\n"),
			/unrecognized transcript line/,
		);
	});

	test("throws on a turn before any section heading", () => {
		assert.throws(
			() => parseTranscript("**Maya:** hi\n"),
			/turn before any section heading/,
		);
	});
});

describe("chunkSection", () => {
	test("keeps everything in one chunk under the limit", () => {
		const turns = [
			{ speaker: "Maya" as const, text: "short" },
			{ speaker: "Dan" as const, text: "also short" },
		];
		const chunks = chunkSection(turns, 100);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0], "Maya: short\nDan: also short");
	});

	test("splits at a turn boundary once the limit is exceeded", () => {
		const turns = [
			{ speaker: "Maya" as const, text: "a".repeat(20) },
			{ speaker: "Dan" as const, text: "b".repeat(20) },
			{ speaker: "Maya" as const, text: "c".repeat(20) },
		];
		const chunks = chunkSection(turns, 30);
		// each line is ~26 chars ("Maya: " + 20), so limit 30 forces one turn per chunk
		assert.equal(chunks.length, 3);
		assert.equal(chunks[0], `Maya: ${"a".repeat(20)}`);
		assert.equal(chunks[1], `Dan: ${"b".repeat(20)}`);
		assert.equal(chunks[2], `Maya: ${"c".repeat(20)}`);
	});

	test("never splits mid-turn even if a single turn exceeds maxChars", () => {
		const turns = [{ speaker: "Maya" as const, text: "x".repeat(50) }];
		const chunks = chunkSection(turns, 10);
		assert.equal(chunks.length, 1);
		assert.equal(chunks[0], `Maya: ${"x".repeat(50)}`);
	});

	test("respects the default 3,500 char limit", () => {
		const turns = [
			{ speaker: "Maya" as const, text: "a".repeat(3490) },
			{ speaker: "Dan" as const, text: "b" },
		];
		const chunks = chunkSection(turns);
		assert.equal(chunks.length, 2);
	});
});

describe("decideRetry", () => {
	test("switches to backup on a per-day quota error when one is available and unused", () => {
		assert.equal(
			decideRetry({
				status: 429,
				body: "quota exceeded: GenerateContentPerDayPerProjectPerModel-FreeTier",
				attempt: 1,
				hasBackup: true,
				onBackup: false,
			}),
			"switch",
		);
	});

	test("throws on a per-day quota error with no backup left", () => {
		assert.equal(
			decideRetry({
				status: 429,
				body: "PerDay quota",
				attempt: 1,
				hasBackup: false,
				onBackup: false,
			}),
			"throw",
		);
	});

	test("throws on a per-day quota error when already on backup", () => {
		assert.equal(
			decideRetry({
				status: 429,
				body: "PerDay quota",
				attempt: 1,
				hasBackup: true,
				onBackup: true,
			}),
			"throw",
		);
	});

	test("retries a non-daily transient error up to 6 attempts", () => {
		assert.equal(
			decideRetry({
				status: 503,
				body: "overloaded",
				attempt: 6,
				hasBackup: false,
				onBackup: false,
			}),
			"retry",
		);
	});

	test("throws past 6 attempts on a non-daily error", () => {
		assert.equal(
			decideRetry({
				status: 503,
				body: "overloaded",
				attempt: 7,
				hasBackup: false,
				onBackup: false,
			}),
			"throw",
		);
	});

	test("throws immediately on a non-retryable status", () => {
		assert.equal(
			decideRetry({
				status: 400,
				body: "bad request",
				attempt: 1,
				hasBackup: true,
				onBackup: false,
			}),
			"throw",
		);
	});
});

describe("chapterTimes", () => {
	test("derives start/end seconds from cumulative PCM byte counts", () => {
		// 24000 samples/sec * 2 bytes/sample = 48000 bytes/sec
		const chapters = chapterTimes([
			{ title: "Opening", bytes: 48000 * 10 },
			{ title: "Last week", bytes: 48000 * 20 },
		]);
		assert.equal(chapters[0].startSec, 0);
		assert.equal(chapters[0].endSec, 10);
		assert.equal(chapters[1].startSec, 10);
		assert.equal(chapters[1].endSec, 30);
	});

	test("empty sections produce a zero-length chapter without shifting later ones", () => {
		const chapters = chapterTimes([
			{ title: "Empty", bytes: 0 },
			{ title: "Next", bytes: 48000 * 5 },
		]);
		assert.equal(chapters[0].startSec, 0);
		assert.equal(chapters[0].endSec, 0);
		assert.equal(chapters[1].startSec, 0);
		assert.equal(chapters[1].endSec, 5);
	});
});

describe("publishEpisodeAudio", () => {
	// The render writes into data/podcast-cache; only this promotes those files
	// into site/public/audio, which every astro build copies into the release.
	// If a rejection mid-render skips the promote, nothing is publicly reachable.
	const slug = `test-promote-${process.pid}`;
	const cache = join(ROOT, "data", "podcast-cache");
	const publicDir = join(ROOT, "site", "public", "audio");
	const publicFiles = [
		join(publicDir, `${slug}.mp3`),
		join(publicDir, `${slug}.chapters.json`),
	];

	test("promotes the MP3 and its chapters sidecar, and only then", () => {
		mkdirSync(cache, { recursive: true });
		writeFileSync(join(cache, `${slug}.mp3`), "mp3");
		writeFileSync(join(cache, `${slug}.chapters.json`), "{}");
		try {
			for (const f of publicFiles) assert.equal(existsSync(f), false);
			publishEpisodeAudio(slug);
			for (const f of publicFiles) assert.equal(existsSync(f), true);
		} finally {
			for (const f of [
				...publicFiles,
				join(cache, `${slug}.mp3`),
				join(cache, `${slug}.chapters.json`),
			])
				rmSync(f, { force: true });
		}
	});

	test("refuses to publish audio that was never rendered", () => {
		// Loud failure beats a published post pointing at a dead /audio URL.
		assert.throws(() => publishEpisodeAudio(`${slug}-missing`), {
			code: "ENOENT",
		});
	});
});
