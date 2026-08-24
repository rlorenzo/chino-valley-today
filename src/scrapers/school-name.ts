// Both athletics sources print a school named after a person surname-first:
// "Ayala, Ruben", "King, Martin Luther", "Roosevelt, Eleanor". Rendered into a
// sentence that becomes "Chino Hills def. King, Martin Luther, 3-1", which
// reads as though we had named a person and reported their score.
//
// That is worse here than ordinary awkwardness. EDITORIAL.md's interim rule for
// high school sports is team-level only, precisely so no student is named, and
// a line that looks like it names someone undoes that on its face — the reader
// cannot tell the difference between a school called King and a person called
// King.

/**
 * Turns a surname-first school name back into the way people say it, and
 * leaves everything else exactly as it came.
 *
 * Deliberately narrow. Only a name whose tail looks like a forename is
 * inverted: letters, spaces and the punctuation that appears in names, one to
 * three words. Anything else — a parenthesised section note, a slash-joined
 * co-op team, a comma used for some other purpose — is returned untouched,
 * because a wrong inversion invents a school that does not exist, which is a
 * worse failure than leaving an awkward one alone.
 */
export function readableSchoolName(name: string): string {
	const trimmed = name.trim();
	const m = /^([^,]+),\s*([A-Za-z][A-Za-z .'’-]*)$/.exec(trimmed);
	if (!m) return trimmed;
	const [, surname, forename] = m;
	// The character class above already excludes digits and brackets, so a
	// section note or a district number never reaches here. Word count is the
	// remaining bound: a forename is not a clause.
	if (forename.trim().split(/\s+/).length > 3) return trimmed;
	return `${forename.trim()} ${surname.trim()}`;
}
