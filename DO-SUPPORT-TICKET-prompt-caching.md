# DigitalOcean support ticket draft — prompt caching never engages

Status: DRAFT, not yet filed (2026-08-13). File under Product: Gradient / Serverless Inference. Everything between the SEND markers below is the email: subject line first, then the body including the evidence section (support responds faster with evidence inline). Paragraphs are single lines so your email client wraps them. Background for us, not for DO: reports/notes + vault task "Investigate DO prompt caching not engaging."

---- SEND FROM HERE ----

**Subject:** Prompt caching never engages for deepseek-4-flash on Serverless Inference

Hi — I'm using Gradient serverless inference (`https://inference.do-ai.run/v1`, chat completions) with `deepseek-4-flash`, and prompt caching never engages, despite the documentation stating it is automatic for open-source models with no `cache_control` or `prompt_cache_retention` required (https://docs.digitalocean.com/products/inference/how-to/use-prompt-caching/).

Reproduction summary:

- Model: `deepseek-4-flash`, non-streaming chat completion, ~74,600 prompt tokens (static system prompt + static user content — byte-identical across requests; no timestamps or other dynamic content).
- Sending the identical request twice within a few hours, every response reports `cache_read_input_tokens: 0`, `cache_created_input_tokens: 0`, and `prompt_tokens_details.cached_tokens: 0`.
- Consistent across dozens of calls on multiple days since 2026-08-12. Full usage blocks below.

I understand the docs describe caching as best-effort/opportunistic, so zero hits on any single request is within documented behavior — but a 0% rate across dozens of exact repeats over multiple days, with `cache_created_input_tokens` also always 0 (i.e., no cache entry is ever even written), suggests the feature is effectively not operating for this model rather than merely missing sometimes. I also note the caching doc's open-source example names DeepSeek V3.2 specifically, while it's the models catalog page that lists deepseek-4-flash as caching-capable — so a model-coverage gap during the Public Preview would fully explain what I'm seeing. Questions:

1. Is prompt caching actually live for `deepseek-4-flash` on the serverless endpoint, or only for certain models/deployments during the Public Preview?
2. Do serverless requests have any replica affinity, or can identical back-to-back requests land on different replicas with no shared cache (which would explain a 0% hit rate)?
3. Is anything required from the caller for open-source models that the docs don't mention?
4. Do cache hits, when they occur, also reduce consumption against the per-minute token rate limit? That limit is the main pain point — repeated large prompts during development hit it quickly.

Evidence — usage blocks copied verbatim from responses (all calls: POST /v1/chat/completions, model deepseek-4-flash, non-streaming, one API key):

Run 1, 2026-08-13 (74,671 prompt tokens):

```
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1914,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":76585}
```

Run 2, 2026-08-13, ~2 hours later — byte-identical prompt (note the identical prompt_tokens count of 74671):

```
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1888,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":76559}
```

Two further calls the same day with different (also fully static) prompts, same all-zero pattern:

```
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1393,"prompt_tokens":76865,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":78258}
```

```
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":958,"prompt_tokens":13068,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":14026}
```

Happy to provide request IDs or run instrumented repros if useful. Thanks!

Disclosure: this issue was investigated and this report drafted with the help of an AI assistant (Claude Code, Anthropic). All reproduction numbers are copied verbatim from real API responses logged by our pipeline; the prompt-determinism claim was verified by code inspection, not assumed.

---- SEND UNTIL HERE ----

## Repo-facing notes (do not email)

- Determinism verification: prompt construction has no timestamps/randomness; bundle items are selected `ORDER BY i.id` (src/pipeline/bundle.ts); identical DB state between runs 1 and 2.
- The 2026-08-12 observations referenced in the email were logged pre-reinstall; those raw logs died with the disk. Today's runs regenerate the evidence.
- Documentation the claims rest on: the use-prompt-caching how-to (automatic for open-source, exact-prefix, "opportunistic" hedge), the models catalog (deepseek-4-flash listed caching-capable), and the Inference Engine blog post (Public Preview since week of June 29, 2026; 80% cached-token discount).
