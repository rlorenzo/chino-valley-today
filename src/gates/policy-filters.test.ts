import assert from "node:assert/strict";
import test from "node:test";
import {
	filterHeadlineEligibility,
	hasUnvettedPrivatePerson,
	isCivicEntity,
	isLocallyRelevant,
	isPublicFigure,
	mentionsMinor,
} from "./policy-filters.ts";

test("policy-filters suite", async (t) => {
	await t.test("mentionsMinor detects explicit minors and youth terms", () => {
		assert.equal(mentionsMinor("A 14-year-old was found safe in Chino"), true);
		assert.equal(
			mentionsMinor("Juvenile arrested following disturbance"),
			true,
		);
		assert.equal(
			mentionsMinor("Boys Republic hosted an adult alumni event"),
			false,
		);
		assert.equal(
			mentionsMinor("Boys & Girls Club announces new director"),
			false,
		);
		// Operator decision 2026-08-19: a high-school name/context alone is not
		// identification of a minor — student press (Quest News, Bulldog Times,
		// The Breeze) names a high school in nearly every item, and this term
		// would otherwise trip the guard on all of them.
		assert.equal(
			mentionsMinor("Incident reported near the high school"),
			false,
		);
		assert.equal(
			mentionsMinor("Incident reported near the middle school"),
			true,
		);
		assert.equal(mentionsMinor("Fundraiser held for the elementary"), true);
		assert.equal(mentionsMinor("Teen volunteers at the food bank"), true);
		assert.equal(mentionsMinor("Juvenile detained after the incident"), true);
		assert.equal(mentionsMinor("A 17-year-old was reported missing"), true);
		// The narrow-signal guard this suite documents above: a bare age must
		// not fire on every adult release.
		assert.equal(
			mentionsMinor("A 40-year-old was arrested on suspicion of DUI"),
			false,
		);
	});

	await t.test(
		"isLocallyRelevant evaluates city metadata and geo aliases",
		() => {
			assert.equal(
				isLocallyRelevant({
					title: "New park opens",
					body: "A ribbon cutting was held today.",
					meta: { city: "Chino" },
				}).relevant,
				true,
			);

			assert.equal(
				isLocallyRelevant({
					title: "Chino Planning Commission approves 7-Eleven",
					body: "Project located on Central Avenue.",
				}).relevant,
				true,
			);

			// Generic community news without geo-alias is rejected
			assert.equal(
				isLocallyRelevant({
					title: "Regional water district holds annual summit",
					body: "Topics included conservation and state mandates.",
					meta: { section: "community_news" },
				}).relevant,
				false,
			);

			// Adjacent city story without Chino anchor is rejected
			assert.equal(
				isLocallyRelevant({
					title: "Ontario airport reports record summer travel numbers",
					body: "Passenger volume increased by 10 percent.",
				}).relevant,
				false,
			);
		},
	);

	await t.test("isCivicEntity matches known landmarks and institutions", () => {
		assert.equal(isCivicEntity("Ayala Park"), true);
		assert.equal(isCivicEntity("Evergreen Devco"), true);
		assert.equal(isCivicEntity("Corner Bar"), true);
		assert.equal(isCivicEntity("Chino High School"), true);
		assert.equal(isCivicEntity("Butterfield Ranch Road"), true);
		assert.equal(isCivicEntity("John Doe"), false);

		// A span that merely contains a civic token is not itself civic: the
		// allowlist carries entries as broad as "Chino" and "Park".
		assert.equal(isCivicEntity("Chino Resident Jane Doe"), false);
		assert.equal(isCivicEntity("California Native John Smith"), false);
		assert.equal(isCivicEntity("Park Ranger Jane Doe"), false);
	});

	await t.test(
		"isPublicFigure matches vetted elected officials and variants",
		() => {
			assert.equal(isPublicFigure("Sonja Shaw"), true);
			assert.equal(isPublicFigure("SONJA SHAW"), true);
			assert.equal(isPublicFigure("S. Shaw"), true);
			assert.equal(isPublicFigure("Sonja M. Shaw"), true);
			assert.equal(isPublicFigure("Peter Rogers"), true);
			assert.equal(isPublicFigure("Curt Hagman"), true);
			assert.equal(isPublicFigure("Jane Doe"), false);

			// Matching only the outer two tokens would whitelist whatever ran
			// together between them in an unpunctuated headline.
			assert.equal(isPublicFigure("Sonja Volunteer Group Meeting Shaw"), false);
		},
	);

	await t.test("every honorific is both scanned for and stripped off", () => {
		// Two derived regexes read this list: one finds "<title> <Name>" in raw
		// article text, the other strips the title back off before the allowlist
		// comparison. A title present in only one of them either lets a private
		// name through unscanned or blocks a vetted official from matching. The
		// abbreviated titles are the ones worth pinning — they carry a period in
		// display form and none in normalized form.
		for (const title of ["Dr.", "Capt.", "Sgt.", "Lt.", "Rev.", "Mayor"]) {
			assert.equal(
				hasUnvettedPrivatePerson(`${title} Jane Doe spoke at the meeting`),
				true,
				`${title} should surface an unvetted name`,
			);
			assert.equal(
				hasUnvettedPrivatePerson(`${title} Sonja Shaw spoke at the meeting`),
				false,
				`${title} should strip cleanly off a vetted figure`,
			);
		}
	});

	await t.test(
		"hasUnvettedPrivatePerson extracts names regardless of diacritics or casing",
		() => {
			// Regression: the candidate regexes were ASCII-only ([A-Z][a-zA-Z]+),
			// so extraction broke at the first accented letter and an accented
			// private name was never even offered to the allowlist check. In a
			// city that is roughly two-thirds Hispanic/Latino that is not an edge
			// case, it is a hole in the guard for the people it most protects.
			// The ASCII and accented spellings must behave identically.
			assert.equal(
				hasUnvettedPrivatePerson("Jose Hernandez opened a bakery on Central"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("José Hernández opened a bakery on Central"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("François Moreau bought the Central lot"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Ana Peña addressed the planning commission"),
				true,
			);

			// All-caps and initial forms, which press headlines use freely.
			assert.equal(
				hasUnvettedPrivatePerson("JANE DOE NAMED IN COUNCIL FILING"),
				true,
			);
			assert.equal(hasUnvettedPrivatePerson("J. Doe filed the appeal"), true);
			assert.equal(
				hasUnvettedPrivatePerson("A. B. Smith purchased the parcel"),
				true,
			);

			// Remaining surname-particle forms from the plan's name matrix.
			assert.equal(
				hasUnvettedPrivatePerson("Vincent van Gogh donated the painting"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Angus MacDonald renewed the lease"),
				true,
			);
		},
	);

	await t.test(
		"allowlist matching folds diacritics so vetted figures stay published",
		() => {
			// The allowlists are ASCII. Without diacritic folding, an outlet
			// spelling a sitting official's name with accents would read as an
			// unvetted private person and their civic coverage would be held —
			// failing safe, but silently suppressing legitimate local news.
			assert.equal(isPublicFigure("Eunice Ulloa"), true);
			assert.equal(isPublicFigure("Eunice Ullóa"), true);
			assert.equal(isPublicFigure("Christopher Flores"), true);
			assert.equal(isPublicFigure("Chrïstopher Florés"), true);

			assert.equal(
				hasUnvettedPrivatePerson("Mayor Eunice Ullóa opened the meeting"),
				false,
			);

			// Folding must not turn a stranger into an allowlisted official.
			assert.equal(isPublicFigure("Random Stranger"), false);
		},
	);

	await t.test(
		"hasUnvettedPrivatePerson detects unvetted proper names and allows vetted ones",
		() => {
			// Unvetted private individuals
			assert.equal(hasUnvettedPrivatePerson("Jane Doe announced plans"), true);
			assert.equal(
				hasUnvettedPrivatePerson("Local resident John Smith spoke to council"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Coach Miller led the practice in Chino"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Mary-Jane O'Connor opened a boutique"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Maria de la Cruz filed the application"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("Frank Lizarraga received county lease"),
				true,
			);

			// Title-cased headlines that lead with a civic token: the token is
			// scrubbed, and the name behind it still has to clear the allowlist.
			assert.equal(
				hasUnvettedPrivatePerson("Chino Resident Jane Doe Announces Campaign"),
				true,
			);
			assert.equal(
				hasUnvettedPrivatePerson("California Native John Smith Donates Land"),
				true,
			);

			// Vetted public figures and civic entities
			assert.equal(
				hasUnvettedPrivatePerson(
					"Sonja Shaw rides anger over COVID rules to bid for state superintendent",
				),
				false,
			);
			assert.equal(
				hasUnvettedPrivatePerson(
					"7-Eleven, gas station, car wash to replace Corner Bar area",
				),
				false,
			);
			assert.equal(
				hasUnvettedPrivatePerson(
					"Mayor Peter Rogers addresses Chino Hills state of the city",
				),
				false,
			);
			// Possessive form of an allowlisted entity ahead of a vetted figure
			assert.equal(
				hasUnvettedPrivatePerson(
					"Chino Valley's Sonja Shaw rides anger over COVID rules",
				),
				false,
			);
		},
	);

	await t.test("filterHeadlineEligibility enforces full policy rules", () => {
		// Valid commercial development
		const eligibleItem = {
			title: "7-Eleven, gas station, car wash to replace Corner Bar area",
			body: "Evergreen Devco will propose a 7-Eleven on Central Avenue for Chino Planning Commission consideration.",
			meta: { city: "Chino" },
		};
		const res1 = filterHeadlineEligibility(eligibleItem);
		assert.equal(res1.eligible, true);

		// Crime story
		const crimeItem = {
			title: "Suspect arrested after commercial burglary in Chino",
			body: "Police took the suspect into custody.",
			meta: { city: "Chino" },
		};
		assert.deepEqual(filterHeadlineEligibility(crimeItem), {
			eligible: false,
			reason: "crime",
		});

		// Law enforcement active investigation / appeal
		const leItem = {
			title: "Police seek public help identifying vehicle in Chino",
			body: "Detectives released surveillance video.",
			meta: { city: "Chino" },
		};
		assert.deepEqual(filterHeadlineEligibility(leItem), {
			eligible: false,
			reason: "law_enforcement",
		});

		// Standalone blotter
		const blotterItem = {
			title: "Chino Police blotter for August 15",
			body: "Incidents reported across the city.",
			meta: { city: "Chino" },
		};
		assert.deepEqual(filterHeadlineEligibility(blotterItem), {
			eligible: false,
			reason: "law_enforcement",
		});

		// Unvetted private person
		const privatePersonItem = {
			title: "Resident Jane Doe organizes neighborhood cleanup in Chino",
			body: "Volunteers gathered at the community center.",
			meta: { city: "Chino" },
		};
		assert.deepEqual(filterHeadlineEligibility(privatePersonItem), {
			eligible: false,
			reason: "private_person",
		});

		// Non-local
		const nonLocalItem = {
			title: "Ontario council approves downtown housing development",
			body: "Project will add 200 units near Euclid Avenue.",
		};
		assert.deepEqual(filterHeadlineEligibility(nonLocalItem), {
			eligible: false,
			reason: "non_local",
		});
	});
});
