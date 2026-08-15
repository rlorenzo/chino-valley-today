// Read-only query helpers over the existing schema (items/documents/sources).
// Tier A generators never write items/documents — only posts, via
// src/pipeline/posts.ts.
import type { Db } from "../db/index.ts";

export interface ItemRow {
	id: number;
	document_id: number;
	source_url: string;
	item_type: string;
	external_id: string | null;
	title: string | null;
	body: string | null;
	meta: string | null;
	occurred_at: string | null;
	source_key: string;
	doc_url: string;
	doc_type: string;
	doc_title: string | null;
	doc_meeting_date: string | null;
	doc_location: string | null;
	doc_event_key: string | null;
}

export function queryItems(
	db: Db,
	opts: { sourceKeys?: string[]; itemTypes?: string[] },
): ItemRow[] {
	const conditions: string[] = [];
	const params: string[] = [];
	if (opts.sourceKeys?.length) {
		conditions.push(`s.key IN (${opts.sourceKeys.map(() => "?").join(",")})`);
		params.push(...opts.sourceKeys);
	}
	if (opts.itemTypes?.length) {
		conditions.push(
			`i.item_type IN (${opts.itemTypes.map(() => "?").join(",")})`,
		);
		params.push(...opts.itemTypes);
	}
	const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
	const sql = `
    SELECT i.id, i.document_id, i.source_url, i.item_type, i.external_id, i.title, i.body, i.meta, i.occurred_at,
           s.key AS source_key, d.url AS doc_url, d.doc_type, d.title AS doc_title,
           d.meeting_date AS doc_meeting_date, d.location AS doc_location, d.event_key AS doc_event_key
    FROM items i
    JOIN documents d ON i.document_id = d.id
    JOIN sources s ON d.source_id = s.id
    ${where}
    ORDER BY i.id ASC
  `;
	return db.raw.prepare(sql).all(...params) as unknown as ItemRow[];
}

export function parseMeta(raw: string | null): Record<string, unknown> {
	if (!raw) return {};
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}
