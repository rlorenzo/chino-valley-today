// Shared rendering helpers for the admin dashboard: HTML escaping, a
// hand-rolled minimal markdown renderer (no dependency — this page sits
// behind Caddy basic auth later and stays dependency-free per PLAN.md), a
// parser for the frontmatter format written by pipeline/posts.ts's
// renderPostFile(), and a schema-agnostic pretty-printer for gates/judge
// JSON that highlights pass/fail where it can detect one.
import type { Tier } from "../pipeline/posts.ts";

export function esc(s: unknown): string {
	return String(s ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function tierBadge(tier: Tier | string): string {
	const cls =
		tier === "A"
			? "badge-a"
			: tier === "B"
				? "badge-b"
				: tier === "C"
					? "badge-c"
					: "";
	return `<span class="badge ${cls}">Tier ${esc(tier)}</span>`;
}

// --- Frontmatter parsing ---------------------------------------------------
// Mirrors the exact format renderPostFile() in pipeline/posts.ts writes:
// a `---` fence, `key: <value>` lines (scalars are JSON-quoted via that
// module's y() helper; post_type/tier are bare enum words), a `sources:`
// key followed by `  - <JSON-quoted-string>` list lines, a closing `---`,
// then the markdown body (which already includes the disclosure footer).
// This is intentionally a parser for THAT format, not general YAML.

export interface ParsedPost {
	title: string;
	postType: string;
	tier: string;
	date: string;
	meetingDate: string | null;
	sources: string[];
	body: string;
}

function scalar(raw: string): string {
	const t = raw.trim();
	if (t.startsWith('"')) {
		try {
			return JSON.parse(t) as string;
		} catch {
			return t;
		}
	}
	return t;
}

export function parsePostFile(raw: string): ParsedPost {
	const lines = raw.split("\n");
	const result: ParsedPost = {
		title: "",
		postType: "",
		tier: "",
		date: "",
		meetingDate: null,
		sources: [],
		body: raw,
	};
	if (lines[0]?.trim() !== "---") return result;
	let i = 1;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") {
			i++;
			break;
		}
		const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
		if (kv) {
			const key = kv[1];
			const rest = kv[2];
			if (key === "sources") continue; // list items follow on subsequent lines
			if (key === "title") result.title = scalar(rest);
			else if (key === "post_type") result.postType = scalar(rest);
			else if (key === "tier") result.tier = scalar(rest);
			else if (key === "date") result.date = scalar(rest);
			else if (key === "meeting_date") result.meetingDate = scalar(rest);
			continue;
		}
		const item = line.match(/^\s*-\s+(.*)$/);
		if (item) result.sources.push(scalar(item[1]));
	}
	result.body = lines.slice(i).join("\n");
	return result;
}

// --- Minimal hand-rolled markdown -> HTML -----------------------------------
// Supports: #.###### headings, --- rules, - / * unordered lists, "1." ordered
// lists, paragraphs, and inline **bold**, *italic*, [text](url) links. This
// is deliberately small — enough to render generated recap prose plus the
// disclosure footer, not a general CommonMark implementation.

function inline(text: string): string {
	let s = esc(text);
	s = s.replace(
		/\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
		'<a href="$2" rel="noopener noreferrer">$1</a>',
	);
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	return s;
}

export function renderMarkdown(md: string): string {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	let para: string[] = [];
	let listType: "ul" | "ol" | null = null;
	let listItems: string[] = [];

	const flushPara = (): void => {
		if (para.length) {
			out.push(`<p>${inline(para.join(" "))}</p>`);
			para = [];
		}
	};
	const flushList = (): void => {
		if (listType) {
			out.push(
				`<${listType}>${listItems.map((it) => `<li>${inline(it)}</li>`).join("")}</${listType}>`,
			);
			listType = null;
			listItems = [];
		}
	};

	for (const line of lines) {
		if (/^\s*$/.test(line)) {
			flushPara();
			flushList();
			continue;
		}
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			flushPara();
			flushList();
			out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
			continue;
		}
		if (/^-{3,}\s*$/.test(line.trim())) {
			flushPara();
			flushList();
			out.push("<hr>");
			continue;
		}
		const ul = line.match(/^\s*[-*]\s+(.*)$/);
		if (ul) {
			flushPara();
			if (listType && listType !== "ul") flushList();
			listType = "ul";
			listItems.push(ul[1]);
			continue;
		}
		const ol = line.match(/^\s*\d+\.\s+(.*)$/);
		if (ol) {
			flushPara();
			if (listType && listType !== "ol") flushList();
			listType = "ol";
			listItems.push(ol[1]);
			continue;
		}
		flushList();
		para.push(line.trim());
	}
	flushPara();
	flushList();
	return out.join("\n");
}

// --- Generic gates/judge JSON -> readable reasons ---------------------------
// The validator (Gate 1) and judge (Gate 2) JSON shapes are not finalized
// elsewhere in this repo yet, so this renders any JSON tree generically, but
// specifically recognizes an object carrying a boolean pass/ok/passed/valid
// field and renders a PASS/FAIL badge for it. Falls back to a plain nested
// structure otherwise — never throws on an unexpected shape.

function passFail(v: unknown): boolean | null {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
	const o = v as Record<string, unknown>;
	for (const key of ["pass", "ok", "passed", "valid"]) {
		if (key in o && typeof o[key] === "boolean") return o[key] as boolean;
	}
	return null;
}

function jsonNode(v: unknown): string {
	if (Array.isArray(v)) {
		if (v.length === 0) return '<span class="muted">[]</span>';
		return `<ul>${v.map((it) => `<li>${jsonNode(it)}</li>`).join("")}</ul>`;
	}
	if (v && typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>);
		if (entries.length === 0) return '<span class="muted">{}</span>';
		return `<div class="jsontree">${entries
			.map(([k, val]) => {
				const pf = passFail(val);
				const badge =
					pf === true
						? '<span class="badge badge-pass">PASS</span> '
						: pf === false
							? '<span class="badge badge-fail">FAIL</span> '
							: "";
				const rowCls =
					pf === false
						? "jsonrow fail"
						: pf === true
							? "jsonrow pass"
							: "jsonrow";
				const rendered =
					val && typeof val === "object"
						? jsonNode(val)
						: `<span>${esc(String(val))}</span>`;
				return `<div class="${rowCls}">${badge}<b>${esc(k)}</b>: ${rendered}</div>`;
			})
			.join("")}</div>`;
	}
	return esc(String(v));
}

export function renderJsonReasons(label: string, raw: string | null): string {
	if (raw == null) return `<p class="muted">${esc(label)}: none</p>`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return `<p class="muted">${esc(label)} (unparseable JSON):</p><pre>${esc(raw)}</pre>`;
	}
	return `<div class="jsonblock"><h4>${esc(label)}</h4>${jsonNode(parsed)}</div>`;
}

// Duck-types a faithfulness score and content flags out of judge JSON for the
// Published feed's glanceable summary. Returns nulls/[] on anything
// unrecognized (including null input, which is normal for Tier A).
export function summarizeJudge(raw: string | null): {
	score: string | null;
	flags: string[];
} {
	if (raw == null) return { score: null, flags: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { score: null, flags: [] };
	}
	if (typeof parsed !== "object" || parsed === null)
		return { score: null, flags: [] };
	const obj = parsed as Record<string, unknown>;
	const scoreKey = ["faithfulness", "faithfulness_score", "score"].find(
		(k) => k in obj,
	);
	const score = scoreKey ? String(obj[scoreKey]) : null;
	const flags: string[] = [];
	const flagsVal = obj.flags ?? obj.content_flags;
	if (Array.isArray(flagsVal)) {
		for (const f of flagsVal) flags.push(String(f));
	} else if (flagsVal && typeof flagsVal === "object") {
		for (const [k, v] of Object.entries(flagsVal as Record<string, unknown>))
			if (v) flags.push(k);
	}
	return { score, flags };
}

// --- Page shell --------------------------------------------------------------

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0 auto; padding: 1.5rem; max-width: 76rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; border-bottom: 2px solid #ddd; padding-bottom: .3rem; margin-top: 2.5rem; }
  h3 { font-size: 1rem; margin: 0 0 .3rem; }
  h4 { font-size: .85rem; margin: .6rem 0 .2rem; text-transform: uppercase; letter-spacing: .03em; color: #555; }
  nav { margin: .5rem 0 1.5rem; }
  nav a { margin-right: 1rem; text-decoration: none; color: #045; font-weight: 600; }
  a { color: #045; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .85rem; }
  th, td { border: 1px solid #ccc; padding: .35rem .5rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; }
  .badge { display: inline-block; padding: .05rem .45rem; border-radius: .8rem; font-size: .72rem; font-weight: 700; white-space: nowrap; }
  .badge-a { background: #e3f4e3; color: #14611e; }
  .badge-b { background: #e6f0fb; color: #14448a; }
  .badge-c { background: #fbe6e6; color: #9c1414; }
  .badge-pass { background: #e3f4e3; color: #14611e; }
  .badge-fail { background: #fbe6e6; color: #9c1414; }
  .badge-warn { background: #fff3cd; color: #856404; }
  .muted { color: #888; }
  .card { border: 1px solid #ddd; border-radius: .4rem; padding: .8rem 1rem; margin-bottom: 1rem; background: #fafafa; }
  .jsontree { margin-left: .8rem; }
  .jsonblock { margin-bottom: .5rem; }
  .jsonrow { padding: .1rem 0; }
  .jsonrow.fail { color: #9c1414; }
  .jsonrow.pass { color: #14611e; }
  pre { background: #f4f4f4; padding: .5rem; overflow-x: auto; white-space: pre-wrap; }
  .draft { border: 1px dashed #bbb; padding: .6rem .8rem; background: #fff; max-height: 24rem; overflow-y: auto; }
  form.inline { display: inline-block; margin-right: .5rem; vertical-align: top; }
  .actions { margin-top: .6rem; display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  button { cursor: pointer; padding: .3rem .7rem; border-radius: .3rem; border: 1px solid #999; background: #fff; font: inherit; }
  button.approve { background: #14611e; color: #fff; border-color: #14611e; }
  button.reject { background: #9c1414; color: #fff; border-color: #9c1414; }
  button.pass { background: #14611e; color: #fff; border-color: #14611e; }
  button.fail { background: #9c1414; color: #fff; border-color: #9c1414; }
  label.ack { display: block; margin: .4rem 0; font-weight: 700; }
  textarea, input[type=text] { font: inherit; padding: .3rem; width: 100%; max-width: 26rem; }
  .error-box { background: #fbe6e6; border: 1px solid #9c1414; color: #9c1414; padding: 1rem; margin: 1rem 0; }
`;

export function layout(title: string, body: string): string {
	return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
<body>
${body}
</body>`;
}
