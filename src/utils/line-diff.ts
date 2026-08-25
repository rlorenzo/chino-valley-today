// A small line diff, for showing an operator what changed in a publisher's
// terms of service.
//
// `source_tos_status` stores only hashes, so a drift hold could say that
// something changed and nothing more; answering "what?" meant reading three
// websites by hand. scripts/check-tos-drift.ts now archives the bytes it
// hashes, and this turns two archived versions back into a reviewable change.
//
// Deliberately not a dependency. A diff is the kind of thing that looks like it
// needs a library right up until you write down what it has to do here: two
// documents of a few thousand lines, read by one person, once a week.

export type DiffOp = "context" | "add" | "remove";

export interface DiffLine {
	op: DiffOp;
	text: string;
}

export interface DiffResult {
	lines: DiffLine[];
	added: number;
	removed: number;
	/** True when the documents were too large to diff exactly; see MAX_CELLS. */
	truncated: boolean;
}

// The LCS table is O(n*m) cells. The observed inputs are the three held
// sources' terms pages: 132, 107 and 280 lines of text once the markup is
// stripped. A million cells is a 1000x1000 document, several times the largest
// of those, and as a flat Int32Array it is 4MB — a real bound rather than a
// hopeful one. A nested number[][] of the same size is many times that once
// per-row array overhead is counted, which is the reason for the typed array
// and not premature cleverness.
const MAX_CELLS = 1_000_000;

/**
 * Longest common subsequence lengths for two line arrays.
 *
 * One flat Int32Array indexed `i * width + j`, walked back from the end. The
 * values are suffix lengths, bounded by the line count, so they fit an int32
 * with room to spare.
 */
function lcs(a: readonly string[], b: readonly string[]): Int32Array {
	const width = b.length + 1;
	const table = new Int32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	return table;
}

/**
 * Line-level diff of `before` against `after`.
 *
 * Identical head and tail lines are trimmed before the table is built, which is
 * what keeps this cheap on the common case: a publisher changing one clause in
 * a page that is otherwise byte-identical.
 */
export function diffLines(
	before: readonly string[],
	after: readonly string[],
): DiffResult {
	let head = 0;
	while (
		head < before.length &&
		head < after.length &&
		before[head] === after[head]
	) {
		head++;
	}
	let tail = 0;
	while (
		tail < before.length - head &&
		tail < after.length - head &&
		before[before.length - 1 - tail] === after[after.length - 1 - tail]
	) {
		tail++;
	}

	const a = before.slice(head, before.length - tail);
	const b = after.slice(head, after.length - tail);

	// The trimmed head and tail are unchanged by definition, but they are still
	// part of the document: carrying them through as context is what lets the
	// formatter show a change in the middle of a page with lines around it.
	const headLines: DiffLine[] = before
		.slice(0, head)
		.map((text) => ({ op: "context" as const, text }));
	const tailLines: DiffLine[] = before
		.slice(before.length - tail)
		.map((text) => ({ op: "context" as const, text }));

	if (a.length === 0 && b.length === 0) {
		return {
			lines: [...headLines, ...tailLines],
			added: 0,
			removed: 0,
			truncated: false,
		};
	}

	if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
		return {
			lines: [],
			added: b.length,
			removed: a.length,
			truncated: true,
		};
	}

	const table = lcs(a, b);
	const width = b.length + 1;
	const lines: DiffLine[] = [...headLines];
	let added = 0;
	let removed = 0;
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			lines.push({ op: "context", text: a[i] });
			i++;
			j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			lines.push({ op: "remove", text: a[i] });
			removed++;
			i++;
		} else {
			lines.push({ op: "add", text: b[j] });
			added++;
			j++;
		}
	}
	for (; i < a.length; i++) {
		lines.push({ op: "remove", text: a[i] });
		removed++;
	}
	for (; j < b.length; j++) {
		lines.push({ op: "add", text: b[j] });
		added++;
	}
	lines.push(...tailLines);

	return { lines, added, removed, truncated: false };
}

/**
 * Renders a diff with `contextLines` of unchanged text around each change, the
 * unchanged runs between them elided. Reading a terms diff means reading the
 * changes, not scrolling a licence agreement.
 */
export function formatDiff(result: DiffResult, contextLines = 2): string {
	if (result.truncated) {
		return (
			`(too large to diff exactly: ${result.removed} line(s) before, ` +
			`${result.added} line(s) after, in the region that differs)`
		);
	}
	// Not a degenerate case to tidy away: it is the most likely answer and the
	// most useful one. All three sources held on 2026-08-23 had changed bytes
	// and unchanged wording, and the elision loop below would have reported that
	// as a lone "... 132 unchanged line(s) ..." — which reads like an empty
	// result rather than like a finding.
	if (result.added === 0 && result.removed === 0) {
		return "(the page changed, but not one word of the text did)";
	}
	const { lines } = result;
	const keep = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].op === "context") continue;
		for (
			let j = Math.max(0, i - contextLines);
			j <= Math.min(lines.length - 1, i + contextLines);
			j++
		) {
			keep.add(j);
		}
	}

	const out: string[] = [];
	let elided = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!keep.has(i)) {
			elided++;
			continue;
		}
		if (elided > 0) {
			out.push(`  ... ${elided} unchanged line(s) ...`);
			elided = 0;
		}
		const { op, text } = lines[i];
		out.push(`${op === "add" ? "+ " : op === "remove" ? "- " : "  "}${text}`);
	}
	if (elided > 0) out.push(`  ... ${elided} unchanged line(s) ...`);
	return out.join("\n");
}
