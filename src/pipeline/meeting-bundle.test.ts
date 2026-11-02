import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/index.ts";
import {
	assembleBundle,
	listRecapTargets,
	renderBundleForPrompt,
} from "./bundle.ts";

const PORTAL =
	"https://publicportal.chinohills.org/WebLink/Browse.aspx?startid=66925";

test("Chino Hills minutes join the recap bundle, even with no agenda or transcript", () => {
	const db = openDb(":memory:");
	db.raw.exec(`
		INSERT OR IGNORE INTO sources (key, name, base_url, method)
		  VALUES ('chinohills-minutes', 'Chino Hills minutes', '${PORTAL}', 'pdf');
		INSERT INTO documents (id, source_id, url, doc_type, meeting_date, fetched_at, content_hash, raw_path)
		  SELECT 1, id, '${PORTAL}', 'minutes', '2026-08-11', '2026-09-26', 'abc123', 'x'
		  FROM sources WHERE key = 'chinohills-minutes';
		INSERT INTO items (document_id, source_url, item_type, external_id, title, body, meta, occurred_at)
		  VALUES (1, '${PORTAL}', 'agenda_item', 'city-council-2026-08-11-1',
		    'CONSENT CALENDAR', 'Motion carried 5-0.',
		    '{"body":"City Council","record":"minutes"}', '2026-08-11');
	`);

	const bundle = assembleBundle(db, "chinohills-swagit", "2026-08-11");
	assert.ok(bundle);
	assert.equal(bundle.bodyName, "Chino Hills City Council");
	assert.equal(bundle.minutesItems.length, 1);
	assert.deepEqual(bundle.allowedUrls, [PORTAL]);
	assert.match(bundle.inputCorpus, /Motion carried 5-0\./);
	assert.match(
		renderBundleForPrompt(bundle),
		/## Minutes[^\n]*\n- CONSENT CALENDAR\n {2}source: \S+\n {2}detail: Motion carried 5-0\./,
	);

	const [target] = listRecapTargets(db);
	assert.equal(target.targetKey, "chinohills-swagit:2026-08-11");
	assert.equal(target.counts.minutesItems, 1);
});

test("closed-session case captions never reach the prompt or the gate corpus", () => {
	const db = openDb(":memory:");
	db.raw.exec(`
		INSERT OR IGNORE INTO sources (key, name, base_url, method)
		  VALUES ('chino-legistar', 'Chino Legistar', 'https://chino.legistar.com', 'api');
		INSERT INTO documents (id, source_id, url, doc_type, meeting_date, fetched_at, content_hash, raw_path)
		  SELECT 1, id, 'https://chino.legistar.com/m', 'agenda', '2026-10-06', '2026-10-07', 'h', 'x'
		  FROM sources WHERE key = 'chino-legistar';
		INSERT INTO items (document_id, source_url, item_type, external_id, title, body, meta, occurred_at)
		  VALUES (1, 'https://chino.legistar.com/i1', 'agenda_item', 'a1',
		    'CONFERENCE WITH LEGAL COUNSEL',
		    'Name of case: Jane Roe and John Roe v. Estate of Sam Doe, City of Chino; No. CIV 1',
		    '{}', '2026-10-06');
	`);
	const bundle = assembleBundle(db, "chino-legistar", "2026-10-06");
	assert.ok(bundle);
	assert.doesNotMatch(renderBundleForPrompt(bundle), /Roe|Doe/);
	assert.doesNotMatch(bundle.inputCorpus, /Roe|Doe/);
	assert.match(renderBundleForPrompt(bundle), /Name of case: \[withheld/);
});
