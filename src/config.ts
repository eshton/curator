import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime configuration for a Curator daemon.
 *
 * Everything is local by design: the daemon binds to loopback only and stores
 * all state under a single directory (default `~/.curator`). Nothing is sent
 * off-machine and there is no telemetry.
 */
export interface CuratorConfig {
  /** Directory holding the database, pid file, log and runtime config. */
  home: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Host to bind. Always loopback — not configurable by design. */
  host: string;
  /** TCP port for the MCP HTTP endpoint. */
  port: number;
  /**
   * Optional shared bearer token. When set, every MCP request must present
   * `Authorization: Bearer <token>`. Off by default to keep local use
   * frictionless; enable for defence-in-depth on shared machines.
   */
  token: string | undefined;
}

/** Host is fixed to loopback: the daemon must never be reachable off-machine. */
export const HOST = "127.0.0.1";
export const DEFAULT_PORT = 3737;
/** Path component of the MCP endpoint, e.g. http://127.0.0.1:3737/mcp */
export const MCP_PATH = "/mcp";

function firstDefined(...vals: (string | undefined)[]): string | undefined {
  return vals.find((v) => v !== undefined && v !== "");
}

export interface ConfigOverrides {
  home?: string;
  dbPath?: string;
  port?: number;
  token?: string;
}

/**
 * Resolve configuration from (in priority order) explicit CLI overrides,
 * environment variables, then built-in defaults.
 */
export function resolveConfig(overrides: ConfigOverrides = {}): CuratorConfig {
  const home =
    firstDefined(overrides.home, process.env.CURATOR_HOME) ??
    join(homedir(), ".curator");

  const dbPath =
    firstDefined(overrides.dbPath, process.env.CURATOR_DB) ??
    join(home, "curator.db");

  const portRaw = firstDefined(
    overrides.port !== undefined ? String(overrides.port) : undefined,
    process.env.CURATOR_PORT,
  );
  const port = portRaw !== undefined ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${portRaw}`);
  }

  const token = firstDefined(overrides.token, process.env.CURATOR_TOKEN);

  return { home, dbPath, host: HOST, port, token };
}

/** Path to the pid file the running daemon writes. */
export function pidFile(home: string): string {
  return join(home, "curator.pid");
}

/** Path to the JSON file describing the running daemon (url, port, token, pid). */
export function runtimeFile(home: string): string {
  return join(home, "runtime.json");
}

/** Path to the daemon log file. */
export function logFile(home: string): string {
  return join(home, "curator.log");
}

/** The full MCP endpoint URL for a given config. */
export function mcpUrl(cfg: Pick<CuratorConfig, "host" | "port">): string {
  return `http://${cfg.host}:${cfg.port}${MCP_PATH}`;
}
