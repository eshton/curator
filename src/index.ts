#!/usr/bin/env bun
import { resolveConfig, mcpUrl, logFile, type ConfigOverrides } from "./config.ts";
import { CURATOR_VERSION } from "./server.ts";
import {
  getRunning,
  runForeground,
  startDaemon,
  stopDaemon,
} from "./daemon.ts";

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const flags: Record<string, string | boolean> = {};
  const rest = command === "help" && argv[0]?.startsWith("-") ? argv : argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
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
  curator help | version

Commands:
  start        Start the local daemon (background). It owns a SQLite file and
               serves an MCP endpoint on http://127.0.0.1:<port>/mcp.
  stop         Stop the running daemon.
  status       Show whether the daemon is running and where.
  restart      Stop then start.
  mcp-config   Print an MCP client config snippet pointing at the daemon.

Options:
  --foreground  Run in the foreground instead of daemonising.
  --port <n>    Port to bind (default 3737, or $CURATOR_PORT).
  --db <path>   SQLite file path (default ~/.curator/curator.db, or $CURATOR_DB).
  --token <t>   Require this bearer token on MCP requests (default: none).
  --home <dir>  State directory (default ~/.curator, or $CURATOR_HOME).

Privacy: binds to 127.0.0.1 only, validates Origin, never phones home.`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "__serve": {
      // Internal: the detached daemon process runs this. Config comes from env.
      await runForeground(resolveConfig());
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
