# DigitalOcean support ticket draft: prompt caching never engages

Status: FILED with DO support 2026-08-13. Kept for the record. File under Product: Gradient / Serverless Inference. Everything between the SEND markers is the email; paragraphs are single lines so your email client wraps them.

---- SEND FROM HERE ----

**Subject:** Prompt caching never engages for deepseek-4-flash

Hello,

I run a small pipeline that generates local news recaps from city council transcripts. Each run sends the same ~74k-token prompt to `deepseek-4-flash` at `inference.do-ai.run`, sometimes several times a day while I'm debugging. Your docs say caching for open-source models just works, no `cache_control` needed (https://docs.digitalocean.com/products/inference/how-to/use-prompt-caching/). I've never gotten a single cached token back. What made me dig in is that `cache_created_input_tokens` is always 0 too. It's not that my requests miss the cache, nothing ever gets written to it in the first place.

Here are two runs from today, about two hours apart. Same prompt both times, and you can see the token counts match exactly:

```
{"cache_created_input_tokens":0,"cache_read_input_tokens":0,"completion_tokens":1914,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":76585}
{"cache_created_input_tokens":0,"cache_read_input_tokens":0,"completion_tokens":1888,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":76559}
```

I checked my side before writing in. The prompt is built from a SQLite query with a fixed ORDER BY, and there are no timestamps or anything else that changes between runs.

I know the docs call caching best-effort, so I'm not claiming a bug exactly. But dozens of calls over several days without one cache write makes me think it's simply not on for this model. A few questions:

1. Is caching actually enabled for `deepseek-4-flash` right now? The caching doc only mentions DeepSeek V3.2 by name; the models catalog is what lists 4-flash as supported.
2. If it is enabled, any idea what would cause zero writes? Do serverless requests get any replica affinity, or is there something I need to send that the docs don't mention?
3. When cache hits do happen, do they count less against the per-minute token rate limit? Honestly that limit is the reason I care. The repeated big prompts eat through it fast.

Happy to send request IDs if that helps. Thanks!

Full disclosure: I did this investigation and drafted this message with an AI assistant (Claude Code). The usage numbers above are copied straight from real API responses.

---- SEND UNTIL HERE ----

## Repo-facing notes (do not email)

- Determinism verification: prompt construction has no timestamps/randomness; bundle items are selected `ORDER BY i.id` (src/pipeline/bundle.ts); identical DB state between the two runs shown.
- Additional all-zero usage blocks from other prompts (76,865 and 13,068 prompt tokens, 2026-08-13) are in the session logs; first observations 2026-08-12 (raw logs lost to the machine reinstall).
- Documentation the claims rest on: the use-prompt-caching how-to (automatic for open-source, exact-prefix matching, "opportunistic" hedge), the models catalog (deepseek-4-flash listed caching-capable), and the Inference Engine blog post (Public Preview since week of June 29, 2026; 80% cached-token discount).
