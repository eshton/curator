#!/usr/bin/env bun
import { resolveConfig, mcpUrl, logFile, type ConfigOverrides } from "./config.ts";
import { CURATOR_VERSION } from "./server.ts";
import {
  getRunning,
  runForeground,
  startDaemon,
  stopDaemon,
} from "./daemon.ts";
import {
  agentLogPath,
  executeAgentRun,
  listAgents,
  runAgentFromEnv,
  startAgentBackground,
  stopAgent,
  type AgentLaunch,
} from "./agentctl.ts";
import { existsSync, readFileSync } from "node:fs";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const rest = command === "help" && argv[0]?.startsWith("-") ? argv : argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, positionals, flags };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Resolve an agent launch spec from flags + environment, erroring if required fields are missing. */
function resolveLaunch(flags: Record<string, string | boolean>): AgentLaunch {
  const task = str(flags.task) ?? process.env.CURATOR_AGENT_TASK;
  const modelUrl = str(flags["model-url"]) ?? process.env.CURATOR_MODEL_URL;
  const model = str(flags.model) ?? process.env.CURATOR_MODEL;
  if (!task) throw new Error("Missing --task (or $CURATOR_AGENT_TASK).");
  if (!modelUrl) throw new Error("Missing --model-url (or $CURATOR_MODEL_URL), e.g. https://api.openai.com/v1");
  if (!model) throw new Error("Missing --model (or $CURATOR_MODEL), e.g. gpt-4o-mini");
  return {
    task,
    modelUrl,
    model,
    modelKey: str(flags["model-key"]) ?? process.env.CURATOR_MODEL_KEY,
    collection: str(flags.collection) ?? process.env.CURATOR_AGENT_COLLECTION ?? "curated",
    author: str(flags.author) ?? process.env.CURATOR_AGENT_AUTHOR ?? "curator-agent",
    maxSteps: Number(str(flags["max-steps"]) ?? process.env.CURATOR_AGENT_MAX_STEPS) || 20,
  };
}

function overridesFromFlags(flags: Record<string, string | boolean>): ConfigOverrides {
  const o: ConfigOverrides = {};
  if (typeof flags.home === "string") o.home = flags.home;
  if (typeof flags.db === "string") o.dbPath = flags.db;
  if (typeof flags.port === "string") o.port = Number(flags.port);
  if (typeof flags.token === "string") o.token = flags.token;
  return o;
}

function mcpConfigSnippet(url: string, token: string | null): string {
  const server: Record<string, unknown> = { type: "http", url };
  if (token) server.headers = { Authorization: `Bearer ${token}` };
  return JSON.stringify({ mcpServers: { curator: server } }, null, 2);
}

const HELP = `curator — privacy-first, agent-first local data curation store (MCP)

Usage:
  curator start [--foreground] [--port <n>] [--db <path>] [--token <t>]
  curator stop
  curator status
  curator restart
  curator mcp-config [--json]
  curator agent run --task <t> --model-url <url> --model <name> [--model-key <k>]
                    [--collection <c>] [--author <a>] [--max-steps <n>] [--foreground]
  curator agent list | logs <id> | stop <id>
  curator help | version

Commands:
  start        Start the local daemon (background). It owns a SQLite file and
               serves an MCP endpoint on http://127.0.0.1:<port>/mcp.
  stop         Stop the running daemon.
  status       Show whether the daemon is running and where.
  restart      Stop then start.
  mcp-config   Print an MCP client config snippet pointing at the daemon.
  agent run    Start an autonomous curation agent (background by default). It
               connects to the daemon over MCP, can search/fetch the web, and
               records its findings into Curator. Auto-starts the daemon.
  agent list   List agent runs and their status.
  agent logs   Print an agent run's log.
  agent stop   Stop a running agent.

Options:
  --foreground  Run in the foreground instead of daemonising.
  --port <n>    Port to bind (default 3737, or $CURATOR_PORT).
  --db <path>   SQLite file path (default ~/.curator/curator.db, or $CURATOR_DB).
  --token <t>   Require this bearer token on MCP requests (default: none).
  --home <dir>  State directory (default ~/.curator, or $CURATOR_HOME).

Agent options:
  --task <t>        The curation task (or $CURATOR_AGENT_TASK).
  --model-url <url> OpenAI-compatible base URL, e.g. https://api.openai.com/v1
                    (or $CURATOR_MODEL_URL). Works with local servers too.
  --model <name>    Model name (or $CURATOR_MODEL).
  --model-key <k>   API key for the endpoint (or $CURATOR_MODEL_KEY; optional for local).
  --collection <c>  Collection to curate into (default "curated").
  --author <a>      Author id recorded on writes (default "curator-agent").
  --max-steps <n>   Max tool-use iterations (default 20).
  Web search (optional): set CURATOR_SEARCH_PROVIDER (tavily|brave) and
  CURATOR_SEARCH_API_KEY to enable the web_search tool; web_fetch always works.

Privacy: the daemon binds to 127.0.0.1 only and never phones home. The agent
makes outbound calls only to your configured model endpoint and the web.`;

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "__serve": {
      // Internal: the detached daemon process runs this. Config comes from env.
      await runForeground(resolveConfig());
      return;
    }

    case "__agent-run": {
      // Internal: the detached agent process runs this. Config comes from env.
      await runAgentFromEnv(resolveConfig());
      return;
    }

    case "agent": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      const sub = positionals[0] ?? "help";
      if (sub === "run") {
        const launch = resolveLaunch(flags);
        if (flags.foreground) {
          const running = getRunning(cfg) ?? (await startDaemon(cfg));
          const id = crypto.randomUUID().slice(0, 8);
          console.log(`Running agent ${id} (foreground). Task: ${launch.task}`);
          await executeAgentRun(cfg, id, launch, running.url, running.token ?? undefined);
          return;
        }
        const { id, logPath } = await startAgentBackground(cfg, launch);
        console.log(`Started agent ${id} in the background.`);
        console.log(`  task: ${launch.task}`);
        console.log(`  log:  ${logPath}`);
        console.log(`\nFollow it with:  curator agent logs ${id}`);
        return;
      }
      if (sub === "list") {
        const agents = listAgents(cfg);
        if (!agents.length) {
          console.log("No agent runs.");
          return;
        }
        for (const a of agents) {
          const state = a.status === "running" ? (a.alive ? "running" : "interrupted") : a.status;
          console.log(`${a.id}  ${state.padEnd(11)}  ${a.model}  →${a.collection}  ${a.startedAt}`);
          console.log(`         ${a.task.slice(0, 100)}`);
          if (a.error) console.log(`         error: ${a.error}`);
        }
        return;
      }
      if (sub === "logs") {
        const id = positionals[1];
        if (!id) throw new Error("Usage: curator agent logs <id>");
        const p = agentLogPath(cfg.home, id);
        if (!existsSync(p)) throw new Error(`No log for agent "${id}".`);
        console.log(readFileSync(p, "utf8"));
        return;
      }
      if (sub === "stop") {
        const id = positionals[1];
        if (!id) throw new Error("Usage: curator agent stop <id>");
        console.log(stopAgent(cfg, id) ? `Stopped agent ${id}.` : `No agent "${id}".`);
        return;
      }
      console.log("Usage: curator agent run|list|logs|stop");
      return;
    }

    case "start": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      if (flags.foreground) {
        await runForeground(cfg);
        return;
      }
      const already = getRunning(cfg);
      if (already) {
        console.log(`Curator is already running at ${already.url} (pid ${already.pid}).`);
        return;
      }
      const info = await startDaemon(cfg);
      console.log(`Curator started at ${info.url} (pid ${info.pid}).`);
      console.log(`  db:  ${info.dbPath}`);
      console.log(`  log: ${logFile(cfg.home)}`);
      console.log("\nAdd this to your MCP client config:\n");
      console.log(mcpConfigSnippet(info.url, info.token));
      return;
    }

    case "stop": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      const stopped = await stopDaemon(cfg);
      console.log(stopped ? "Curator stopped." : "Curator is not running.");
      return;
    }

    case "status": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      const running = getRunning(cfg);
      if (flags.json) {
        console.log(JSON.stringify({ running: !!running, ...(running ?? {}) }, null, 2));
        return;
      }
      if (!running) {
        console.log("Curator is not running.");
        return;
      }
      console.log(`Curator is running.`);
      console.log(`  url:     ${running.url}`);
      console.log(`  pid:     ${running.pid}`);
      console.log(`  db:      ${running.dbPath}`);
      console.log(`  token:   ${running.token ? "required" : "none"}`);
      console.log(`  started: ${running.startedAt || "unknown"}`);
      return;
    }

    case "restart": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      await stopDaemon(cfg);
      const info = await startDaemon(cfg);
      console.log(`Curator restarted at ${info.url} (pid ${info.pid}).`);
      return;
    }

    case "mcp-config": {
      const cfg = resolveConfig(overridesFromFlags(flags));
      const running = getRunning(cfg);
      const url = running?.url ?? mcpUrl(cfg);
      const token = running?.token ?? cfg.token ?? null;
      console.log(mcpConfigSnippet(url, token));
      return;
    }

    case "version":
    case "--version":
    case "-v":
      console.log(CURATOR_VERSION);
      return;

    case "help":
    case "--help":
    case "-h":
    default:
      console.log(HELP);
      return;
  }
}

main().catch((err) => {
  console.error(`curator: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
