import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { extractNixlePermalink, messageToItemDraft } from './sbsheriff-nixle-mail.ts';

// Synthetic .eml modeled on the observed Nixle message shape (permalink form
// nixle.us/XXXXX verified live against the channel 2026-08-12 — see
// reports/notes/sbsheriff-news.md probe log). The exact email template is
// unverified until the first real alert arrives; these tests pin the parts we
// depend on (permalink extraction, provenance fail-closed, priority tag).
const ALERT_EML = Buffer.from(
  [
    'From: Chino Hills Police Department <noreply@nixle.us>',
    'To: chinovalleytoday+nixle@gmail.com',
    'Delivered-To: chinovalleytoday+nixle@gmail.com',
    'Message-ID: <alert-1@nixle.us>',
    'Date: Thu, 16 Jul 2026 10:38:00 -0700',
    'Subject: Advisory: Traffic collision investigation on Grand Ave',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The Chino Hills Police Department is investigating a traffic collision',
    'on Grand Ave between Peyton Dr and Boys Republic Dr.',
    '',
    'For full details, view this message on the web at https://nixle.us/HG583',
    '',
  ].join('\r\n')
);

const CONFIRMATION_EML = Buffer.from(
  [
    'From: Nixle <noreply@nixle.us>',
    'To: chinovalleytoday+nixle@gmail.com',
    'Message-ID: <welcome-1@nixle.us>',
    'Date: Wed, 13 Aug 2026 09:00:00 -0700',
    'Subject: Welcome to Nixle — confirm your subscription',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Thanks for signing up. Manage your settings at https://local.nixle.com/register/',
    '',
  ].join('\r\n')
);

describe('nixle permalink extraction', () => {
  test('extracts the nixle.us short link and code', () => {
    const p = extractNixlePermalink('view this message on the web at https://nixle.us/HG583 today');
    assert.deepEqual(p, { url: 'https://nixle.us/HG583', code: 'HG583' });
  });

  test('does not match the channel or register URLs on local.nixle.com', () => {
    assert.equal(extractNixlePermalink('see https://local.nixle.com/register/ and nothing else'), null);
  });
});

describe('message -> item draft', () => {
  test('a real alert maps to a draft with permalink provenance and priority tag', async () => {
    const mail = await simpleParser(ALERT_EML);
    const draft = messageToItemDraft({
      subject: mail.subject ?? null,
      date: mail.date ?? null,
      text: mail.text ?? null,
      html: typeof mail.html === 'string' ? mail.html : null,
      from: mail.from?.text ?? null,
      messageId: mail.messageId ?? null,
    });
    assert.ok(draft);
    assert.equal(draft.external_id, 'HG583');
    assert.equal(draft.source_url, 'https://nixle.us/HG583');
    assert.equal(draft.title, 'Advisory: Traffic collision investigation on Grand Ave');
    assert.equal(draft.meta.priority, 'advisory');
    assert.equal(draft.meta.tier, 'C');
    assert.ok(draft.occurred_at?.startsWith('2026-07-16T17:38'));
    assert.ok(draft.body.includes('Grand Ave between Peyton Dr'));
  });

  test('fail-closed: a message without a nixle.us permalink is never ingested', async () => {
    const mail = await simpleParser(CONFIRMATION_EML);
    const draft = messageToItemDraft({
      subject: mail.subject ?? null,
      date: mail.date ?? null,
      text: mail.text ?? null,
      html: typeof mail.html === 'string' ? mail.html : null,
      from: mail.from?.text ?? null,
      messageId: mail.messageId ?? null,
    });
    assert.equal(draft, null);
  });
});
