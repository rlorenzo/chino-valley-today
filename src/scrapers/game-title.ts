// Both athletics sources say the same thing about the same game, and the two
// parts that are easy to get subtly wrong are shared: the winner's score leads
// even when the loss is ours, and a tie is a result rather than a fixture. Two
// copies of that rule is two chances for one to drift, and the drift would
// surface in a published line rather than in a test.

/** The three outcomes both sources record. Anything else is not a result. */
export type GameResult = "W" | "L" | "T";

export interface GameOutcome {
	/** Our school, as it should read in the sentence. */
	school: string;
	opponent: string;
	/** Null when the game has not been played, or the source half-entered it. */
	result: GameResult | null;
	/** Our score and theirs, as the source printed them. */
	score: string;
	opponentScore: string;
	/** Only consulted when there is no result: home reads "vs", away "at". */
	home: boolean;
}

/**
 * How the game went from our side — the clause that follows the sport.
 *
 * The winner's score leads in every played line, ours or not: "Chino lost to
 * Colony, 8-10" reads as though the larger number were ours.
 */
export function outcomeClause({
	school,
	opponent,
	result,
	score,
	opponentScore,
	home,
}: GameOutcome): string {
	switch (result) {
		case "W":
			return `${school} def. ${opponent}, ${score}-${opponentScore}`;
		case "L":
			return `${school} lost to ${opponent}, ${opponentScore}-${score}`;
		case "T":
			return `${school} tied ${opponent}, ${score}-${opponentScore}`;
		default:
			return `${school} ${home ? "vs" : "at"} ${opponent}`;
	}
}
