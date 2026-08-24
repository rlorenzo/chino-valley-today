import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type GameOutcome, outcomeClause } from "./game-title.ts";

const BASE: GameOutcome = {
	school: "Chino Hills",
	opponent: "Colony",
	result: null,
	score: "",
	opponentScore: "",
	home: true,
};

describe("outcomeClause", () => {
	it("leads with the winner's score on a win", () => {
		assert.equal(
			outcomeClause({ ...BASE, result: "W", score: "21", opponentScore: "10" }),
			"Chino Hills def. Colony, 21-10",
		);
	});

	it("leads with the winner's score on a loss too", () => {
		// The reader-facing bug this guards, in both sources at once: "lost to
		// Colony, 8-10" reads as though the larger number were ours.
		assert.equal(
			outcomeClause({ ...BASE, result: "L", score: "8", opponentScore: "10" }),
			"Chino Hills lost to Colony, 10-8",
		);
	});

	it("names a tie as a result, not as a fixture", () => {
		assert.equal(
			outcomeClause({ ...BASE, result: "T", score: "2", opponentScore: "2" }),
			"Chino Hills tied Colony, 2-2",
		);
	});

	it("says vs at home and at away when there is no result", () => {
		assert.equal(outcomeClause(BASE), "Chino Hills vs Colony");
		assert.equal(
			outcomeClause({ ...BASE, home: false }),
			"Chino Hills at Colony",
		);
	});

	it("never prints a score without a result to explain it", () => {
		// A half-entered row carries a number but no outcome. Printing it under
		// "vs" would read as a final score nobody has confirmed.
		assert.equal(
			outcomeClause({ ...BASE, score: "5", opponentScore: "" }),
			"Chino Hills vs Colony",
		);
	});
});
