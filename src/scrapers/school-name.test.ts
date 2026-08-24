import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readableSchoolName } from "./school-name.ts";

describe("readableSchoolName", () => {
	it("un-inverts a school named after a person", () => {
		// All three appear live in the athletics feeds.
		assert.equal(readableSchoolName("Ayala, Ruben"), "Ruben Ayala");
		assert.equal(readableSchoolName("Roosevelt, Eleanor"), "Eleanor Roosevelt");
		assert.equal(
			readableSchoolName("King, Martin Luther"),
			"Martin Luther King",
		);
		assert.equal(readableSchoolName("Beckman, Arnold"), "Arnold Beckman");
	});

	it("leaves an ordinary school name alone", () => {
		for (const name of [
			"Chino Hills",
			"Ontario Christian",
			"Quartz Hill",
			"Vista Del Lago/Moreno Valley",
			"St. Pius X - St. Matthias Academy",
		]) {
			assert.equal(readableSchoolName(name), name);
		}
	});

	it("does not invert a section note or anything with digits", () => {
		// A wrong inversion invents a school that does not exist, which is worse
		// than leaving an awkward name alone.
		assert.equal(
			readableSchoolName("El Camino (San Diego Section)"),
			"El Camino (San Diego Section)",
		);
		assert.equal(
			readableSchoolName("Somewhere, District 5"),
			"Somewhere, District 5",
		);
	});

	it("does not invert a tail too long to be a forename", () => {
		const long = "Somewhere, a much longer trailing clause here";
		assert.equal(readableSchoolName(long), long);
	});

	it("trims without otherwise touching the name", () => {
		assert.equal(readableSchoolName("  Chino Hills  "), "Chino Hills");
		assert.equal(readableSchoolName(""), "");
	});
});
