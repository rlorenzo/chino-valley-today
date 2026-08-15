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
	// failure modes) — DeepSeek generates, Qwen judges. Backup: glm-5.2.
	judge: {
		model: process.env.CVT_MODEL_JUDGE ?? "qwen3.5-397b-a17b",
		endpoint: DO_ENDPOINT,
		temperature: 0,
	},
	// Backup judge when the primary is overloaded — also a non-DeepSeek family,
	// so the cross-family constraint holds.
	judge_backup: {
		model: process.env.CVT_MODEL_JUDGE_BACKUP ?? "glm-5.2",
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
