# student-press — Quest News, Bulldog Times, The Breeze (SNO platform)

Probed 2026-08-19 (pipeline UA, robots read first, Crawl-delay 6 honored).
Operator decision same day: student press joins headlines-elsewhere (high
school and college; middle school and below out of scope). EDITORIAL.md
2026-08-19 amendment has the policy trail.

## Probe findings

- **Quest News** (`dalquestnews.org/feed/`): valid WordPress RSS, 10 items,
  newest 2026-04-16 (dormant over summer). When active it does real local
  hard news — 2 of 10 window items were directly Chino Hills-relevant (a
  neighborhood explosion injuring 8; an ICE raid at a Chino Hills car wash).
  Note both of those would be held by the crime/LE policy filters — the
  eligible remainder is features/community coverage.
- **Bulldog Times** (`ayalabulldogtimes.org/feed/`): valid RSS, 10 items,
  newest 2026-05-21. Arts/features/opinion in the current window.
- **The Breeze** (`thebreezepaper.com/feed/`): valid RSS, 10 items spanning
  ~3 months with a ~7-week summer gap; full text in content:encoded. Only 2
  Chino mentions in the window, both about the California Institution for
  Men journalism program — Rancho Cucamonga-centric otherwise, hence
  text-matched relevance instead of meta.city.

## ToS

No reader-facing ToS exists on any of the three (checked homepages + footers;
The Breeze's only "terms of service" link is a donation-checkout ToS at
snosites.com/donation-terms-of-service/, which does not govern reading or
linking). robots.txt is tracked in source_tos_status as the binding access
document for each. The two HS papers serve byte-identical SNO template
robots (sha256 ba956d06…); The Breeze's differs (253de8d8…, /cgi-bin/ only).

## Minors posture

Student papers are written by and about a community of minors. What binds,
per the 2026-08-19 EDITORIAL amendment: the unvetted-private-person guard,
under-18 ages, and the juvenile/teen/child vocabulary — "high school" itself
no longer trips the guard (operator directive). Student papers cap at 2
headlines/brief.
