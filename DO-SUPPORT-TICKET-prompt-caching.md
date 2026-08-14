# DigitalOcean support ticket draft — prompt caching never engages

Status: DRAFT, not yet filed (2026-08-13). File under Product: Gradient / Serverless Inference. Everything between the SEND markers is the email; paragraphs are single lines so your email client wraps them.

---- SEND FROM HERE ----

**Subject:** Prompt caching never engages for deepseek-4-flash on Serverless Inference

Hi — per the docs (https://docs.digitalocean.com/products/inference/how-to/use-prompt-caching/), prompt caching is automatic for open-source models. But calling `deepseek-4-flash` via `https://inference.do-ai.run/v1/chat/completions` with byte-identical ~74k-token prompts (fully static content, verified deterministic), I have never seen a cache hit — and `cache_created_input_tokens` is also always 0, so no cache entry is ever even written. This has held across dozens of calls over multiple days.

Two identical requests, ~2 hours apart (note the identical prompt_tokens):

```
{"cache_created_input_tokens":0,"cache_read_input_tokens":0,"completion_tokens":1914,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":76585}
{"cache_created_input_tokens":0,"cache_read_input_tokens":0,"completion_tokens":1888,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"total_tokens":76559}
```

I understand caching is best-effort, but a 0% write rate on ideal input looks like the feature isn't operating for this model at all. Questions:

1. Is caching actually live for `deepseek-4-flash` during the Public Preview? (The caching doc's example names DeepSeek V3.2; only the models catalog lists 4-flash as caching-capable.)
2. If it is live, what explains zero cache writes on identical prompts — e.g., no replica affinity on serverless routing, or something required from the caller that the docs don't mention?
3. Do cache hits reduce consumption against the per-minute token rate limit? That limit is my main pain point with repeated large prompts.

Happy to provide request IDs or run instrumented repros. Thanks!

Disclosure: investigated and drafted with the help of an AI assistant (Claude Code, Anthropic); usage numbers are verbatim from real API responses.

---- SEND UNTIL HERE ----

## Repo-facing notes (do not email)

- Determinism verification: prompt construction has no timestamps/randomness; bundle items are selected `ORDER BY i.id` (src/pipeline/bundle.ts); identical DB state between the two runs shown.
- Additional all-zero usage blocks from other prompts (76,865 and 13,068 prompt tokens, 2026-08-13) are in the session logs; first observations 2026-08-12 (raw logs lost to the machine reinstall).
- Documentation the claims rest on: the use-prompt-caching how-to (automatic for open-source, exact-prefix matching, "opportunistic" hedge), the models catalog (deepseek-4-flash listed caching-capable), and the Inference Engine blog post (Public Preview since week of June 29, 2026; 80% cached-token discount).
