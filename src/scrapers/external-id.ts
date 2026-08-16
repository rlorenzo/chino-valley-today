// Helpers for building item external_ids.
//
// external_id is half of item identity — insertItem resolves an item as
// (document url, item_type, external_id) — so an external_id that can repeat
// for two genuinely different items lets them merge into one row.
//
// The failure this guards against is specific: several sources publish more
// than one meeting on the same date. cvusd-board runs Regular, Special and
// Organizational meetings; chino-agendacenter carries a separate agenda series
// per commission. A bare `<date>-<n>` therefore collides between them, and item
// 1 of the Regular meeting and item 1 of the Special meeting on the same date
// would resolve to the same identity.

// Lowercases and reduces to [a-z0-9-], so a discriminator taken from page text
// ("Community Services Commission", "Regular") is safe inside an id and stays
// stable across runs.
export function idSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// `<date>-<discriminator>-<suffix>`, skipping the discriminator when the source
// gives us nothing usable — better a bare date than the literal string
// "undefined" baked into a stored identity.
export function meetingScopedId(
	isoDate: string,
	discriminator: string | null | undefined,
	suffix: string | number,
): string {
	const slug = discriminator ? idSlug(discriminator) : "";
	return slug ? `${isoDate}-${slug}-${suffix}` : `${isoDate}-${suffix}`;
}
