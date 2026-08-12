// npm run llm:check — verify configured model names against the DigitalOcean
// Inference catalog.
import { LLM_TASKS, apiKeyFor } from './config.ts';

const endpoint = LLM_TASKS.generator.endpoint;
let key: string;
try {
  key = apiKeyFor('generator');
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

const res = await fetch(`${endpoint}/models`, {
  headers: { authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error(`GET ${endpoint}/models -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const data = (await res.json()) as { data?: Array<{ id: string }> };
const available = (data.data ?? []).map((m) => m.id).sort();
console.log(`Endpoint ${endpoint} — ${available.length} models available:`);
for (const id of available) console.log(`  ${id}`);

let ok = true;
for (const [task, cfg] of Object.entries(LLM_TASKS)) {
  const found = available.includes(cfg.model);
  if (!found) ok = false;
  console.log(`${found ? 'OK  ' : 'MISS'} ${task}: ${cfg.model}${found ? '' : '  <-- not in catalog; set CVT_MODEL_* in .env'}`);
}
process.exit(ok ? 0 : 2);
