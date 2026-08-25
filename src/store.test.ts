import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { findRaw, readRaw, saveRaw } from "./store.ts";

let tmpDir: string;

before(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "cvt-store-test-"));
	process.env.CVT_RAW_ROOT = tmpDir;
});

after(() => {
	delete process.env.CVT_RAW_ROOT;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("readRaw", () => {
	test("reads an entry the archive actually holds", () => {
		const { rawPath } = saveRaw(Buffer.from("archived bytes"), "html");
		assert.equal(readRaw(rawPath).toString(), "archived bytes");
	});

	test("refuses a path that climbs out of the archive", () => {
		// documents.raw_path only ever holds what saveRaw wrote, so this is a
		// guard rather than a live hole — but join() folds "../.." away happily,
		// and the guarantee should not rest on a database column staying honest.
		assert.throws(
			() => readRaw("data/raw/../../../etc/passwd"),
			/refusing to read outside the raw archive/,
		);
	});

	test("refuses an absolute path", () => {
		assert.throws(
			() => readRaw("/etc/passwd"),
			/refusing to read outside the raw archive/,
		);
	});

	test("refuses a sibling directory that merely shares a prefix", () => {
		// data/rawsecrets/ is not data/raw/, and a naive startsWith on the
		// undelimited prefix would have said it was.
		assert.throws(
			() => readRaw("data/rawsecrets/x.html"),
			/refusing to read outside the raw archive/,
		);
	});
});

describe("findRaw", () => {
	test("finds an entry by hash alone, whatever its extension", () => {
		// source_tos_status stores a sha256 and nothing else, so the hash has to
		// be enough to get back to the bytes it names.
		const { hash, rawPath } = saveRaw(Buffer.from("terms v1"), "html");
		assert.equal(findRaw(hash), rawPath);
		assert.equal(readRaw(rawPath).toString(), "terms v1");
	});

	test("returns null for a hash that was never archived", () => {
		assert.equal(findRaw("a".repeat(64)), null);
	});

	test("refuses anything that is not a bare sha256", () => {
		// The hash arrives from a database column and leaves as a path, so a
		// value that is not an archive entry must not become a traversal.
		assert.equal(findRaw("../../etc/passwd"), null);
		assert.equal(findRaw(""), null);
		assert.equal(findRaw("ZZ".repeat(32)), null);
	});

	test("ignores a neighbour whose name merely starts with the same hex", () => {
		const { hash } = saveRaw(Buffer.from("real entry"), "html");
		const decoy = join(
			tmpDir,
			"data",
			"raw",
			hash.slice(0, 2),
			`${hash}x.html`,
		);
		writeFileSync(decoy, "not this one");
		assert.equal(readRaw(findRaw(hash) as string).toString(), "real entry");
	});
});
