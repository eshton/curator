import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CuratorConfig } from "./config.ts";
import { getRunning, startDaemon } from "./daemon.ts";
import { runAgent, type AgentConfig } from "./agent.ts";

/**
 * Background lifecycle for curation agents: spawn detached runs, track them
 * with a metadata + log file under `~/.curator/agents/`, and list/stop them.
 */

export interface AgentLaunch {
  task: string;
  modelUrl: string;
  model: string;
  modelKey?: string;
  collection: string;
  author: string;
  maxSteps: number;
}

export interface AgentMeta extends AgentLaunch {
  id: string;
  pid: number;
  startedAt: string;
  status: "running" | "completed" | "failed";
  endedAt?: string;
  steps?: number;
  totalTokens?: number;
  error?: string;
  modelKey?: undefined; // never persisted
}

function agentsDir(home: string): string {
  const dir = join(home, "agents");
  mkdirSync(dir, { recursive: true });
  return dir;
}
function metaPath(home: string, id: string): string {
  return join(agentsDir(home), `${id}.json`);
}
export function agentLogPath(home: string, id: string): string {
  return join(agentsDir(home), `${id}.log`);
}

function writeMeta(home: string, meta: AgentMeta): void {
  const { modelKey, ...safe } = meta; // never persist the API key
  void modelKey;
  writeFileSync(metaPath(home, meta.id), JSON.stringify(safe, null, 2), { mode: 0o600 });
}
export function readMeta(home: string, id: string): AgentMeta | null {
  const p = metaPath(home, id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as AgentMeta;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function listAgents(cfg: CuratorConfig): (AgentMeta & { alive: boolean })[] {
  const dir = agentsDir(cfg.home);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readMeta(cfg.home, f.replace(/\.json$/, "")))
    .filter((m): m is AgentMeta => m !== null)
    .map((m) => ({
      ...m,
      // a "running" meta whose process is gone was interrupted (e.g. reboot)
      alive: m.status === "running" && isAlive(m.pid),
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function stopAgent(cfg: CuratorConfig, id: string): boolean {
  const meta = readMeta(cfg.home, id);
  if (!meta) return false;
  if (isAlive(meta.pid)) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  writeMeta(cfg.home, { ...meta, status: "failed", error: "stopped by user", endedAt: new Date().toISOString() });
  return true;
}

function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Execute an agent run in the current process, maintaining its metadata file.
 * Used directly for foreground runs and by the detached background process.
 */
export async function executeAgentRun(
  cfg: CuratorConfig,
  id: string,
  launch: AgentLaunch,
  mcpUrl: string,
  mcpToken: string | undefined,
): Promise<void> {
  const started = readMeta(cfg.home, id)?.startedAt ?? new Date().toISOString();
  const base: AgentMeta = { ...launch, modelKey: undefined, id, pid: process.pid, startedAt: started, status: "running" };
  writeMeta(cfg.home, base);

  const agentConfig: AgentConfig = {
    task: launch.task,
    mcpUrl,
    mcpToken,
    modelUrl: launch.modelUrl,
    model: launch.model,
    modelKey: launch.modelKey,
    collection: launch.collection,
    author: launch.author,
    maxSteps: launch.maxSteps,
    web: {
      searchProvider: process.env.CURATOR_SEARCH_PROVIDER,
      searchApiKey: process.env.CURATOR_SEARCH_API_KEY,
    },
  };

  try {
    const result = await runAgent(agentConfig, (line) => console.error(`[agent ${id}] ${line}`));
    writeMeta(cfg.home, {
      ...base,
      status: "completed",
      endedAt: new Date().toISOString(),
      steps: result.steps,
      totalTokens: result.totalTokens,
    });
    console.error(`[agent ${id}] done: ${result.stoppedReason}, ${result.steps} steps, ~${result.totalTokens} tokens.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeMeta(cfg.home, { ...base, status: "failed", endedAt: new Date().toISOString(), error: message });
    console.error(`[agent ${id}] failed: ${message}`);
    throw err;
  }
}

/**
 * Start an agent as a detached background process. Ensures the Curator daemon
 * is running first (the agent records its work through it over MCP).
 */
export async function startAgentBackground(
  cfg: CuratorConfig,
  launch: AgentLaunch,
): Promise<{ id: string; logPath: string }> {
  const running = getRunning(cfg) ?? (await startDaemon(cfg));
  const id = shortId();
  // Seed the metadata file so `agent list` shows it immediately.
  writeMeta(cfg.home, { ...launch, modelKey: undefined, id, pid: 0, startedAt: new Date().toISOString(), status: "running" });

  const out = openSync(agentLogPath(cfg.home, id), "a");
  const child = spawn(process.execPath, [Bun.main, "__agent-run"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      CURATOR_HOME: cfg.home,
      CURATOR_DB: cfg.dbPath,
      CURATOR_PORT: String(cfg.port),
      ...(cfg.token ? { CURATOR_TOKEN: cfg.token } : {}),
      CURATOR_MCP_URL: running.url,
      CURATOR_AGENT_ID: id,
      CURATOR_AGENT_TASK: launch.task,
      CURATOR_MODEL_URL: launch.modelUrl,
      CURATOR_MODEL: launch.model,
      ...(launch.modelKey ? { CURATOR_MODEL_KEY: launch.modelKey } : {}),
      CURATOR_AGENT_COLLECTION: launch.collection,
      CURATOR_AGENT_AUTHOR: launch.author,
      CURATOR_AGENT_MAX_STEPS: String(launch.maxSteps),
    },
  });
  child.unref();
  return { id, logPath: agentLogPath(cfg.home, id) };
}

/** Entry point for the detached `__agent-run` process: reconstruct config from env. */
export async function runAgentFromEnv(cfg: CuratorConfig): Promise<void> {
  const id = process.env.CURATOR_AGENT_ID;
  const mcpUrl = process.env.CURATOR_MCP_URL;
  if (!id || !mcpUrl) throw new Error("__agent-run requires CURATOR_AGENT_ID and CURATOR_MCP_URL.");
  const launch: AgentLaunch = {
    task: process.env.CURATOR_AGENT_TASK ?? "",
    modelUrl: process.env.CURATOR_MODEL_URL ?? "",
    model: process.env.CURATOR_MODEL ?? "",
    modelKey: process.env.CURATOR_MODEL_KEY,
    collection: process.env.CURATOR_AGENT_COLLECTION ?? "curated",
    author: process.env.CURATOR_AGENT_AUTHOR ?? "curator-agent",
    maxSteps: Number(process.env.CURATOR_AGENT_MAX_STEPS) || 20,
  };
  await executeAgentRun(cfg, id, launch, mcpUrl, process.env.CURATOR_TOKEN);
}
