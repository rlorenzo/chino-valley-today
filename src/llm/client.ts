// Minimal OpenAI-compatible chat client for DO Gradient serverless inference.
import { LLM_TASKS, apiKeyFor, type LlmTask } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
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
  opts: { maxTokens?: number; jsonObject?: boolean } = {}
): Promise<ChatResult> {
  const cfg = LLM_TASKS[task];
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature,
    max_tokens: opts.maxTokens ?? 4096,
  };
  if (opts.jsonObject) body.response_format = { type: 'json_object' };

  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKeyFor(task)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt <= 2) {
      await new Promise((r) => setTimeout(r, attempt * 10_000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`LLM ${task} (${cfg.model}) HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
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
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(stripped) as T;
}
