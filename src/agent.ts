import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OpenAIClient, type ChatMessage, type ToolDef } from "./llm.ts";
import { execWebTool, isWebTool, webToolDefs, type WebToolEnv } from "./webtools.ts";

/**
 * An autonomous curation agent. Given a task and an OpenAI-compatible model
 * endpoint, it connects to the running Curator daemon as an MCP client, is
 * offered the daemon's curation tools plus local web tools, and drives a
 * tool-use loop — recording its work into Curator as it goes.
 */
export interface AgentConfig {
  task: string;
  mcpUrl: string;
  mcpToken?: string;
  modelUrl: string;
  model: string;
  modelKey?: string;
  collection: string;
  author: string;
  maxSteps: number;
  web: WebToolEnv;
}

export interface AgentResult {
  steps: number;
  totalTokens: number;
  stoppedReason: "completed" | "max_steps";
}

type Logger = (line: string) => void;

function systemPrompt(cfg: AgentConfig): string {
  return [
    "You are Curator Agent, an autonomous data-curation worker.",
    "Your job: accomplish the user's task by gathering and verifying information, then RECORDING your findings into the Curator store using the provided tools.",
    "",
    "Guidelines:",
    `- Save each discrete finding as its own record with save_record, into the "${cfg.collection}" collection unless the task says otherwise.`,
    "- Always include a `source` (the URL or origin) and useful `tags`. Set `status` to \"verified\" only when you have corroborated a fact.",
    `- Set author to "${cfg.author}" on writes so your contributions are attributable.`,
    "- Before saving, use search_records to avoid duplicating an existing record; prefer update_record when refining one.",
    "- Use link_records to connect related records (e.g. rel \"cites\", \"supports\", \"derived_from\"), including across collections.",
    "- Use web_search to discover sources and web_fetch to read them before recording anything from them.",
    "- Work in small steps. When the task is complete (or no further useful curation is possible), reply with a short plain-text summary and DO NOT call any more tools.",
  ].join("\n");
}

/** Extract the plain-text payload from an MCP tool result. */
function toolResultText(res: CallToolResult): string {
  const text = res.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n");
  return res.isError ? `ERROR: ${text}` : text;
}

export async function runAgent(cfg: AgentConfig, log: Logger = () => {}): Promise<AgentResult> {
  const client = new Client({ name: "curator-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
      requestInit: cfg.mcpToken ? { headers: { Authorization: `Bearer ${cfg.mcpToken}` } } : undefined,
    }),
  );
  try {
    const { tools } = await client.listTools();
    const curatorNames = new Set(tools.map((t) => t.name));
    const curatorDefs: ToolDef[] = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.inputSchema as object) ?? { type: "object", properties: {} },
      },
    }));
    const toolDefs = [...curatorDefs, ...webToolDefs()];
    log(`Connected to Curator MCP; ${curatorNames.size} curation tools + ${webToolDefs().length} web tools available.`);

    const llm = new OpenAIClient(cfg.modelUrl, cfg.model, cfg.modelKey);
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(cfg) },
      { role: "user", content: cfg.task },
    ];

    let totalTokens = 0;
    for (let step = 1; step <= cfg.maxSteps; step++) {
      const resp = await llm.chat(messages, toolDefs);
      totalTokens += resp.usage?.total_tokens ?? 0;
      messages.push(resp.message);

      const calls = resp.message.tool_calls ?? [];
      if (calls.length === 0) {
        log(`Step ${step}: agent finished. ${resp.message.content ?? ""}`.trim());
        return { steps: step, totalTokens, stoppedReason: "completed" };
      }

      for (const call of calls) {
        const name = call.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          messages.push({ role: "tool", tool_call_id: call.id, content: `ERROR: arguments were not valid JSON: ${call.function.arguments}` });
          continue;
        }
        let result: string;
        try {
          if (curatorNames.has(name)) {
            const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
            result = toolResultText(res);
          } else if (isWebTool(name)) {
            result = await execWebTool(name, args, cfg.web);
          } else {
            result = `ERROR: unknown tool "${name}".`;
          }
        } catch (err) {
          result = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
        }
        log(`Step ${step}: ${name}(${JSON.stringify(args).slice(0, 120)}) -> ${result.slice(0, 120)}`);
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    log(`Reached max steps (${cfg.maxSteps}).`);
    return { steps: cfg.maxSteps, totalTokens, stoppedReason: "max_steps" };
  } finally {
    await client.close();
  }
}
