// Per-task LLM config (PLAN.md model ladder). Every task is repointable via
// env without code changes — including to Anthropic (any OpenAI-compatible
// endpoint). Verify configured model names against the DigitalOcean Inference
// catalog with `npm run llm:check`.
import { join } from "node:path";
import { ROOT } from "../store.ts";

try {
	process.loadEnvFile(join(ROOT, ".env"));
} catch {
	// no .env yet — fine for everything except live LLM calls
}

export type LlmTask = "generator" | "judge" | "judge_backup" | "escalation";

export interface TaskConfig {
	model: string;
	endpoint: string; // OpenAI-compatible base URL (no trailing slash)
	temperature: number;
}

// First set env var wins.
const API_KEY_ENVS = ["DO_INFERENCE_API_KEY", "DO_GRADIENT_API_KEY"] as const;

const DO_ENDPOINT = (
	process.env.LLM_ENDPOINT ?? "https://inference.do-ai.run/v1"
).replace(/\/$/, "");

export const LLM_TASKS: Record<LlmTask, TaskConfig> = {
	// Long-context generator: full transcript + agenda packet in one call.
	generator: {
		model: process.env.CVT_MODEL_GENERATOR ?? "deepseek-4-flash",
		endpoint: DO_ENDPOINT,
		temperature: 0.1,
	},
	// Judge MUST be a different model family than the generator (uncorrelated
	// failure modes) — DeepSeek generates, GLM judges. Backup: Qwen, a third
	// family again, so a primary outage does not fall back into a correlated
	// one.
	//
	// Was qwen3.5-397b-a17b until 2026-09-14. A 397B judge over a podcast
	// transcript ran past the 15-minute client timeout and took the weekly
	// episode down with it; the verdict JSON is long (one claims[] entry per
	// cited turn) and nothing capped it. See the retry budget in client.ts.
	judge: {
		model: process.env.CVT_MODEL_JUDGE ?? "glm-5.3",
		endpoint: DO_ENDPOINT,
		temperature: 0,
	},
	// Backup judge when the primary is overloaded — a third family again, so
	// neither judge correlates with the generator or with each other.
	//
	// Measured on the same held podcast draft, 2026-09-14: kimi-k3 10.2s and a
	// clean verdict; qwen3.5-397b-a17b never returned (three runs, each dead at
	// 300s); glm-5.2 answers HTTP 400 to reasoning_effort, which the judge call
	// now depends on. Those two are why the backup is not simply the old primary.
	judge_backup: {
		model: process.env.CVT_MODEL_JUDGE_BACKUP ?? "kimi-k3",
		endpoint: DO_ENDPOINT,
		temperature: 0,
	},
	// For post types that repeatedly fail gates or unusually contentious meetings.
	escalation: {
		model: process.env.CVT_MODEL_ESCALATION ?? "kimi-k3",
		endpoint: DO_ENDPOINT,
		temperature: 0.1,
	},
};

export function apiKeyFor(_task: LlmTask): string {
	for (const name of API_KEY_ENVS) {
		const key = process.env[name];
		if (key) return key;
	}
	throw new Error(
		"DO_INFERENCE_API_KEY is not set — create a model access key in the DigitalOcean control panel " +
			"(INFERENCE -> Manage -> Create model access key) and put it in .env (see .env.example; " +
			"DO_GRADIENT_API_KEY is also accepted)",
	);
}
