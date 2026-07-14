/**
 * Minimal client for an OpenAI-compatible Chat Completions endpoint with
 * function calling. Works with OpenAI, OpenRouter, gateways, and local servers
 * (Ollama, llama.cpp, vLLM, LM Studio) — anything that speaks
 * `POST {baseUrl}/chat/completions`.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: { name: string; description?: string; parameters: object };
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finish_reason: string;
  usage?: Usage;
}

export class OpenAIClient {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
  ) {}

  async chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatResponse> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Model endpoint returned ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: { message: ChatMessage; finish_reason: string }[];
      usage?: Usage;
    };
    const choice = data.choices?.[0];
    if (!choice) throw new Error("Model endpoint returned no choices.");
    return { message: choice.message, finish_reason: choice.finish_reason, usage: data.usage };
  }
}
