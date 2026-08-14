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
