#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "autopilot-demo-"));
const env = { ...process.env, AUTOPILOT_HOME: home, AUTOPILOT_TICKET_ID: "DEMO-1042" };
const seeded = spawnSync(process.execPath, ["demo/seed.ts"], { cwd, env, stdio: "inherit" });
if (seeded.status !== 0) {
  rmSync(home, { recursive: true, force: true });
  process.exit(seeded.status ?? 1);
}

const child = spawn("pnpm", ["exec", "vite", "dev", "--host", "127.0.0.1", "--port", process.env.AUTOPILOT_DEMO_PORT ?? "12781"], { cwd, env, stdio: "inherit", detached: true });
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* deja termine */ }
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", (error) => { console.error(error.message); rmSync(home, { recursive: true, force: true }); process.exitCode = 1; });
child.on("exit", (code) => { rmSync(home, { recursive: true, force: true }); process.exitCode = stopping ? 0 : code ?? 1; });
