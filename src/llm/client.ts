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

// Total wall-clock one chat() call may spend, retries and backoff included.
// Retries used to be unbounded in aggregate: the judge's 15-minute per-attempt
// timeout times four attempts is an hour, inside a systemd unit that gives the
// whole run 30 minutes. The first retry could therefore never finish — the unit
// was always SIGTERMed mid-attempt, which is how the 2026-09-14 podcast died.
// Giving up inside the window turns that into a clean, logged failure that the
// next timer firing can retry.
// ponytail: a per-CALL ceiling, not a per-run one. A gated run makes up to
// four of these (generate, repair, judge, backup judge), so a pathological run
// can still outlast a 20-minute unit. Give runGatedPipeline a single deadline
// it divides among its calls if that ever actually fires.
const DEFAULT_BUDGET_MS = Number(process.env.CVT_LLM_BUDGET_MS ?? 10 * 60_000);

export async function chat(
	task: LlmTask,
	messages: ChatMessage[],
	opts: {
		maxTokens?: number;
		jsonObject?: boolean;
		timeoutMs?: number;
		budgetMs?: number;
		reasoningEffort?: "low" | "medium" | "high";
	} = {},
): Promise<ChatResult> {
	const cfg = LLM_TASKS[task];
	const body: Record<string, unknown> = {
		model: cfg.model,
		messages,
		temperature: cfg.temperature,
		max_tokens: opts.maxTokens ?? 4096,
	};
	// Every judge model DO serves reasons before it answers, and on a long
	// draft that reasoning is most of the completion: an uncapped verdict ran
	// 15+ minutes, and capping it at 8192 tokens just truncated the JSON
	// mid-thought. "low" cut a real podcast verdict from 8192 tokens (truncated,
	// 249s) to 561 tokens (complete, 18.5s). Not universal — glm-5.2 answers
	// HTTP 400 to it — so it is opt-in per call, not a default.
	if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
	if (opts.jsonObject) {
		body.response_format = { type: "json_object" };
		// DO Gradient used to reject max_tokens combined with json_object (HTTP
		// 400, "omit max token limits for structured outputs to avoid truncated
		// JSON responses") — observed 2026-08-14 — so the cap was dropped here.
		// Re-probed 2026-09-14: glm-5.3, glm-5.2, qwen3.5-397b-a17b and kimi-k3
		// all return HTTP 200 with both set. Keeping the cap matters because
		// every judge model on the platform is now a reasoning model: without
		// it a verdict runs until the client timeout, which is what took the
		// weekly podcast down.
	}

	const perAttemptMs = opts.timeoutMs ?? 600_000;
	const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
	const startedAt = Date.now();
	// True when another attempt plus its backoff would run past the budget, so
	// we stop instead of starting work that is certain to be killed.
	const outOfBudget = (backoffMs: number) =>
		Date.now() + backoffMs + perAttemptMs > startedAt + budgetMs;

	let attempt = 0;
	for (;;) {
		attempt++;
		let res: Awaited<ReturnType<typeof undiciFetch>>;
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
			const backoff = attempt * 15_000;
			const why =
				err instanceof Error
					? err.cause instanceof Error
						? err.cause.message
						: err.message
					: String(err);
			if (attempt <= 4 && !outOfBudget(backoff)) {
				console.log(
					`LLM ${task} network error (attempt ${attempt}): ${why} — retrying`,
				);
				await new Promise((r) => setTimeout(r, backoff));
				continue;
			}
			if (attempt <= 4)
				console.log(
					`LLM ${task} network error (attempt ${attempt}): ${why} — out of budget after ${Math.round((Date.now() - startedAt) / 1000)}s, giving up`,
				);
			throw err;
		}
		if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
			// Rate limits are per-minute token windows; short waits burn retries
			// inside the same window.
			const backoff = attempt * 45_000;
			if (outOfBudget(backoff)) {
				console.log(
					`LLM ${task} HTTP ${res.status} (attempt ${attempt}) — out of budget after ${Math.round((Date.now() - startedAt) / 1000)}s, giving up`,
				);
				throw new Error(
					`LLM ${task} (${cfg.model}) HTTP ${res.status}: retry budget exhausted`,
				);
			}
			await new Promise((r) => setTimeout(r, backoff));
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
