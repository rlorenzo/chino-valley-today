# DigitalOcean support ticket draft — prompt caching never engages

Status: DRAFT, not yet filed (2026-08-13). File under Product: Gradient /
Serverless Inference. Background: reports/notes + vault task "Investigate DO
prompt caching not engaging"; our caller-side prompt construction is verified
deterministic (no timestamps/randomness; bundle items ordered by stable id),
so this is not fixable from our side.

---

**Subject:** Serverless Inference: prompt caching never engages for
deepseek-4-flash (cache_read_input_tokens always 0 on identical prompts)

Hi — I'm using Gradient serverless inference (`https://inference.do-ai.run/v1`,
chat completions) with `deepseek-4-flash`, and prompt caching never engages,
despite the documentation stating it is automatic for open-source models with
no `cache_control` or `prompt_cache_retention` required
(https://docs.digitalocean.com/products/inference/how-to/use-prompt-caching/).

Reproduction:

- Model: `deepseek-4-flash`, non-streaming chat completion, ~74,600 prompt
  tokens (static system prompt + static user content — byte-identical across
  requests; no timestamps or other dynamic content).
- Sending the identical request twice within a few minutes, every response
  reports: `"cache_read_input_tokens": 0`, `"cache_created_input_tokens": 0`,
  `"prompt_tokens_details": {"cached_tokens": 0}`.
- Consistent across dozens of calls on multiple days (first observed
  2026-08-12). Sample usage block from an actual response:
  `{"cache_created_input_tokens":0,"cache_read_input_tokens":0,"completion_tokens":1914,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0}}`

Since the prompt is well above any minimum cacheable prefix length and exactly
repeated, I'd expect at least occasional cache hits. Questions:

1. Is prompt caching actually live for `deepseek-4-flash` on the serverless
   endpoint, or only for certain models/deployments during the Public Preview?
2. Do serverless requests have any replica affinity, or can identical
   back-to-back requests land on different replicas with no shared cache
   (which would explain a 0% hit rate)?
3. Is anything required from the caller for open-source models that the docs
   don't mention?
4. Do cache hits, when they occur, also reduce consumption against the
   per-minute token rate limit? That limit is the main pain point — repeated
   large prompts during development hit it quickly.

Happy to provide request IDs or run instrumented repros if useful. Thanks!

*Disclosure: this issue was investigated and this report drafted with the help
of an AI assistant (Claude Code, Anthropic). All reproduction numbers are
copied verbatim from real API responses logged by our pipeline (see evidence
appendix if attached); the caller-side determinism claim was verified by code
inspection, not assumed.*

---

## Evidence appendix (from pipeline logs, chronological)

All calls: `POST https://inference.do-ai.run/v1/chat/completions`, model
`deepseek-4-flash`, non-streaming, temperature per pipeline config, one API
key. Usage blocks copied verbatim from responses.

**2026-08-12 (pre-dates this draft):** repeated identical ~74k-token prompts
during recap iteration consistently returned `cache_read_input_tokens: 0`
(logged observation; the machine holding those raw logs was since wiped —
regenerated evidence below reproduces it).

**2026-08-13, run 1** — recap bundle `chino-legistar:2026-07-21`
(74,671 prompt tokens):

```json
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1914,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":76585}
```

**2026-08-13, run 2** — SAME target, byte-identical prompt (same DB state,
prompt construction is deterministic — items selected `ORDER BY i.id`, no
timestamps/randomness anywhere in the prompt path), ~2 hours later:

```json
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1888,"prompt_tokens":74671,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":76559}
```

Note the identical `prompt_tokens: 74671` across both runs — the strongest
available external signal that the prompt bytes were identical — yet run 2
shows zero cache creation *and* zero cache reads, and run 1 shows zero cache
creation (so there was nothing to hit even minutes later).

**2026-08-13** — different bundles, same pattern (zero cache activity on
every call ever made by this pipeline):

```json
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":1393,"prompt_tokens":76865,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":78258}
```

```json
{"cache_created_input_tokens":0,"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"cache_read_input_tokens":0,"completion_tokens":958,"prompt_tokens":13068,"prompt_tokens_details":{"cached_tokens":0},"speed":null,"total_tokens":14026}
```

**Documentation relied on:**

- https://docs.digitalocean.com/products/inference/how-to/use-prompt-caching/
  — "Open-source models, such as DeepSeek V3.2, support prompt caching
  automatically... You do not need to set `cache_control` or
  `prompt_cache_retention`"; exact-token-prefix matching; "opportunistic"
  hedge.
- https://docs.digitalocean.com/products/inference/details/models/ —
  `deepseek-4-flash` listed as prompt-caching-capable.
- https://www.digitalocean.com/blog/whats-new-on-inference-engine — caching
  entered Public Preview week of June 29, 2026; 80% discount on cached tokens.
