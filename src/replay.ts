// Record on one machine, replay on another.
//
// YouTube (bot check) and Swagit (HTTP 403) block the droplet's IP but not a
// home connection. So a person runs the scraper on their own machine with
// CVT_RECORD_DIR set, which saves every response the scraper receives, ships
// that directory to the droplet, and runs the same scraper there with
// CVT_REPLAY_DIR set. The droplet run answers each request from the recording
// and ingests into the production DB exactly as a live run would: same
// selection, same parsing, same archive path.
//
// The timers never set either variable, so a scheduled run still hits the
// network and still fails while the block lasts. That failure is the signal
// that someone needs to do the manual pull; a replay dir left in .env would
// silently re-ingest a stale recording forever.
//
// A replay miss falls through to the real request. A recording is a set of
// answers, not a whitelist.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function dirs(): { record?: string; replay?: string } {
	const record = process.env.CVT_RECORD_DIR || undefined;
	const replay = process.env.CVT_REPLAY_DIR || undefined;
	if (record && replay)
		throw new Error("set CVT_RECORD_DIR or CVT_REPLAY_DIR, not both");
	return { record, replay };
}

/** True while recording: callers must not send conditional-GET headers, since
 * a 304 recorded against this machine's DB means nothing to the replaying one. */
export function recording(): boolean {
	return Boolean(dirs().record);
}

export interface Codec<T> {
	encode(value: T): Buffer;
	decode(bytes: Buffer): T;
}

export const bufferCodec: Codec<Buffer> = {
	encode: (b) => b,
	decode: (b) => b,
};
export const stringCodec: Codec<string> = {
	encode: (s) => Buffer.from(s, "utf8"),
	decode: (b) => b.toString("utf8"),
};

function fileFor(dir: string, key: string): string {
	return join(dir, createHash("sha256").update(key).digest("hex"));
}

/** `produce()`, or its recorded answer for `key` when replaying. */
export async function recorded<T>(
	key: string,
	produce: () => Promise<T>,
	codec: Codec<T>,
): Promise<T> {
	const { record, replay } = dirs();
	if (replay) {
		const file = fileFor(replay, key);
		if (existsSync(file)) return codec.decode(readFileSync(file));
	}
	const value = await produce();
	if (record) {
		mkdirSync(record, { recursive: true });
		writeFileSync(fileFor(record, key), codec.encode(value));
	}
	return value;
}
