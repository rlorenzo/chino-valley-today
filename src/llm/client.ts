// Minimal OpenAI-compatible chat client for DigitalOcean serverless inference.
import { Agent, fetch as undiciFetch } from "undici";
import { apiKeyFor, LLM_TASKS, type LlmTask } from "./config.ts";

// Non-streaming completions on large prompts can take minutes before the
// server sends response headers; undici's default headersTimeout (5 min)
// kills the judge call. One shared agent with generous limits.
const llmAgent = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatResult {
	content: string;
	model: string;
	usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function chat(
	task: LlmTask,
	messages: ChatMessage[],
	opts: { maxTokens?: number; jsonObject?: boolean; timeoutMs?: number } = {},
): Promise<ChatResult> {
	const cfg = LLM_TASKS[task];
	const body: Record<string, unknown> = {
		model: cfg.model,
		messages,
		temperature: cfg.temperature,
		max_tokens: opts.maxTokens ?? 4096,
	};
	if (opts.jsonObject) {
		body.response_format = { type: "json_object" };
		// DO Gradient rejects max_tokens combined with json_object (HTTP 400,
		// "omit max token limits for structured outputs to avoid truncated JSON
		// responses") — observed 2026-08-14 on both judge models.
		delete body.max_tokens;
	}

	let attempt = 0;
	for (;;) {
		attempt++;
		let res;
		try {
			res = await undiciFetch(`${cfg.endpoint}/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKeyFor(task)}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(opts.timeoutMs ?? 600_000),
				dispatcher: llmAgent,
			});
		} catch (err) {
			// Network-level failure (connection reset, DNS, TLS read) — retry with
			// backoff just like an overloaded-platform response.
			if (attempt <= 4) {
				console.log(
					`LLM ${task} network error (attempt ${attempt}): ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : err} — retrying`,
				);
				await new Promise((r) => setTimeout(r, attempt * 15_000));
				continue;
			}
			throw err;
		}
		if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
			// Rate limits are per-minute token windows; short waits burn retries
			// inside the same window.
			await new Promise((r) => setTimeout(r, attempt * 45_000));
			continue;
		}
		if (!res.ok) {
			throw new Error(
				`LLM ${task} (${cfg.model}) HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`,
			);
		}
		const data = (await res.json()) as {
			choices: Array<{ message: { content: string } }>;
			model?: string;
			usage?: { prompt_tokens?: number; completion_tokens?: number };
		};
		const content = data.choices?.[0]?.message?.content;
		if (!content) throw new Error(`LLM ${task} returned an empty completion`);
		return { content, model: data.model ?? cfg.model, usage: data.usage };
	}
}

// Parse a judge/extractor response that should be a single JSON object; strips
// accidental markdown fences before parsing.
export function parseJsonResponse<T>(content: string): T {
	const stripped = content
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "");
	return JSON.parse(stripped) as T;
}
