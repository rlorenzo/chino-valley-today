import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { recorded, recording, stringCodec } from "./replay.ts";

test("a recorded answer replays without calling the producer; a miss falls through", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cvt-replay-"));
	try {
		process.env.CVT_RECORD_DIR = dir;
		assert.equal(recording(), true);
		assert.equal(await recorded("k", async () => "live", stringCodec), "live");

		delete process.env.CVT_RECORD_DIR;
		process.env.CVT_REPLAY_DIR = dir;
		assert.equal(recording(), false);
		assert.equal(
			await recorded(
				"k",
				async () => assert.fail("replay must not produce"),
				stringCodec,
			),
			"live",
		);
		assert.equal(
			await recorded("other", async () => "fresh", stringCodec),
			"fresh",
		);
	} finally {
		delete process.env.CVT_RECORD_DIR;
		delete process.env.CVT_REPLAY_DIR;
	}
});
