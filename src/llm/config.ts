// Per-task LLM config (PLAN.md model ladder). Every task is repointable via
// env without code changes — including to Anthropic (any OpenAI-compatible
// endpoint). Verify the DO Gradient catalog with `npm run llm:check`; it
// moves fast and PLAN's model names may need updating here.
import { join } from 'node:path';
import { ROOT } from '../store.ts';

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  // no .env yet — fine for everything except live LLM calls
}

export type LlmTask = 'generator' | 'judge' | 'escalation';

export interface TaskConfig {
  model: string;
  endpoint: string; // OpenAI-compatible base URL (no trailing slash)
  apiKeyEnv: string; // env var NAME holding the key (never the key itself)
  temperature: number;
}

const DO_ENDPOINT = (process.env.LLM_ENDPOINT ?? 'https://inference.do-ai.run/v1').replace(/\/$/, '');

export const LLM_TASKS: Record<LlmTask, TaskConfig> = {
  // Long-context generator: full transcript + agenda packet in one call.
  generator: {
    model: process.env.CVT_MODEL_GENERATOR ?? 'deepseek-4-flash',
    endpoint: DO_ENDPOINT,
    apiKeyEnv: 'DO_GRADIENT_API_KEY',
    temperature: 0.1,
  },
  // Judge MUST be a different model family than the generator (uncorrelated
  // failure modes) — DeepSeek generates, Qwen judges. Backup: glm-5.2.
  judge: {
    model: process.env.CVT_MODEL_JUDGE ?? 'qwen3.5-397b-a17b',
    endpoint: DO_ENDPOINT,
    apiKeyEnv: 'DO_GRADIENT_API_KEY',
    temperature: 0,
  },
  // For post types that repeatedly fail gates or unusually contentious meetings.
  escalation: {
    model: process.env.CVT_MODEL_ESCALATION ?? 'kimi-k3',
    endpoint: DO_ENDPOINT,
    apiKeyEnv: 'DO_GRADIENT_API_KEY',
    temperature: 0.1,
  },
};

export function apiKeyFor(task: LlmTask): string {
  const cfg = LLM_TASKS[task];
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    throw new Error(
      `${cfg.apiKeyEnv} is not set — create a DigitalOcean Gradient model access key and put it in .env (see .env.example)`
    );
  }
  return key;
}
