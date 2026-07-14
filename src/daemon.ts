import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { CuratorConfig } from "./config.ts";
import { logFile, mcpUrl, pidFile, runtimeFile } from "./config.ts";
import { openDatabase } from "./db.ts";
import { Repository } from "./repository.ts";
import { startHttpServer } from "./http.ts";

export interface RuntimeInfo {
  pid: number;
  host: string;
  port: number;
  url: string;
  token: string | null;
  dbPath: string;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRuntime(cfg: CuratorConfig): RuntimeInfo | null {
  const file = runtimeFile(cfg.home);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RuntimeInfo;
  } catch {
    return null;
  }
}

/** Return the running daemon's info, cleaning up stale state if the pid is dead. */
export function getRunning(cfg: CuratorConfig): RuntimeInfo | null {
  const pidPath = pidFile(cfg.home);
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8").trim());
  if (!Number.isInteger(pid) || !isAlive(pid)) {
    cleanupState(cfg);
    return null;
  }
  return readRuntime(cfg) ?? { pid, host: cfg.host, port: cfg.port, url: mcpUrl(cfg), token: cfg.token ?? null, dbPath: cfg.dbPath, startedAt: "" };
}

function cleanupState(cfg: CuratorConfig): void {
  for (const f of [pidFile(cfg.home), runtimeFile(cfg.home)]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run the server in the foreground (the daemon process itself runs this, and
 * `start --foreground` uses it directly). Writes runtime state and installs
 * signal handlers for a clean shutdown.
 */
export async function runForeground(cfg: CuratorConfig): Promise<void> {
  mkdirSync(cfg.home, { recursive: true });
  const db = openDatabase(cfg.dbPath);
  const repo = new Repository(db);
  const running = await startHttpServer(repo, cfg);

  const info: RuntimeInfo = {
    pid: process.pid,
    host: cfg.host,
    port: cfg.port,
    url: mcpUrl(cfg),
    token: cfg.token ?? null,
    dbPath: cfg.dbPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(pidFile(cfg.home), String(process.pid), { mode: 0o600 });
  writeFileSync(runtimeFile(cfg.home), JSON.stringify(info, null, 2), { mode: 0o600 });

  console.error(`[curator] listening on ${info.url} (db: ${cfg.dbPath})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[curator] received ${signal}, shutting down`);
    await running.stop();
    db.close();
    cleanupState(cfg);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/** Wait until the daemon answers /health, or time out. */
async function waitForHealth(cfg: CuratorConfig, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${cfg.host}:${cfg.port}/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(100);
  }
  return false;
}

/**
 * Start the daemon as a detached background process. Assumes execution under
 * the Bun runtime (spawns `bun <entry> __serve`); config is passed via env so
 * the child resolves identical settings.
 */
export async function startDaemon(cfg: CuratorConfig): Promise<RuntimeInfo> {
  const existing = getRunning(cfg);
  if (existing) return existing;

  mkdirSync(cfg.home, { recursive: true });
  const out = openSync(logFile(cfg.home), "a");

  const child = spawn(process.execPath, [Bun.main, "__serve"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      CURATOR_HOME: cfg.home,
      CURATOR_DB: cfg.dbPath,
      CURATOR_PORT: String(cfg.port),
      ...(cfg.token ? { CURATOR_TOKEN: cfg.token } : {}),
    },
  });
  child.unref();

  const healthy = await waitForHealth(cfg);
  if (!healthy) {
    throw new Error(
      `Daemon did not become healthy on ${cfg.host}:${cfg.port}. Check the log: ${logFile(cfg.home)}`,
    );
  }
  return getRunning(cfg)!;
}

/** Stop the running daemon, if any. Returns true if one was stopped. */
export async function stopDaemon(cfg: CuratorConfig): Promise<boolean> {
  const running = getRunning(cfg);
  if (!running) return false;
  try {
    process.kill(running.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(running.pid)) {
    await Bun.sleep(100);
  }
  if (isAlive(running.pid)) {
    try {
      process.kill(running.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  cleanupState(cfg);
  return true;
}
