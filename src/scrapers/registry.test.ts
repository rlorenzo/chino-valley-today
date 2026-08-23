import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOURCE_TOS_REGISTRY } from "../gates/tos-config.ts";
import { SCRAPERS } from "./registry.ts";
import type { ScraperDef } from "./types.ts";

describe("scraper registry", () => {
	it("every registered module loads and answers to its registry key", async () => {
		// run-one.ts imports by the registry key but consults the ToS gate with
		// def.key. If the two disagree, a gated source silently runs ungated —
		// which is exactly the kind of drift a factory-built def can introduce,
		// since its key is now a config field rather than a literal in the file.
		for (const [key, path] of Object.entries(SCRAPERS)) {
			const mod = await import(`../${path.replace(/^\.\//, "")}`);
			const def = mod.default as ScraperDef;
			assert.ok(def, `${key}: module has no default export`);
			assert.equal(
				def.key,
				key,
				`${key}: def.key does not match its registry key`,
			);
			assert.ok(def.name, `${key}: def has no name`);
			assert.equal(typeof def.run, "function", `${key}: def has no run()`);
		}
	});

	it("every ToS record answers to its own registry key", () => {
		for (const [key, cfg] of Object.entries(SOURCE_TOS_REGISTRY)) {
			assert.equal(cfg.source_key, key, `${key}: source_key does not match`);
		}
	});

	it("keeps a ToS record for each Home Campus school", () => {
		// No reader-facing terms page exists for these, so robots.txt is the
		// binding access document and has to be tracked for drift like any other.
		for (const key of ["chinohigh-sports", "ayala-sports", "donlugo-sports"]) {
			assert.ok(SOURCE_TOS_REGISTRY[key], `${key}: no ToS record`);
			assert.ok(SCRAPERS[key], `${key}: not in the scraper registry`);
		}
	});
});
