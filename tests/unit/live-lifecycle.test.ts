import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { loadRegistry } from "../../plugins/autopilot/mcp/lib/config.ts";
import { readLiveSession, writeLiveSession } from "../../plugins/autopilot/mcp/lib/events.ts";
import { patchTicketState } from "../../plugins/autopilot/mcp/lib/store.ts";
import { stringifyStrict } from "../../plugins/autopilot/mcp/lib/yaml.ts";
import { toolByName } from "../../plugins/autopilot/mcp/registry.ts";
import { sandboxHome, sandboxProject, useProjectConfig } from "../helpers.ts";

it("un pnpm absent ne tue pas le serveur MCP et ne laisse pas de PID invalide", async () => {
  const home = sandboxHome();
  const path = process.env.PATH;
  try {
    process.env.PATH = join(home.home, "no-executable");
    const result = await toolByName("launch-live-mode")!.handler({ ticketId: "TJ-901", runId: "r" }, {
      canAskHuman: false, heartbeat: () => {}, askHuman: async () => ({ action: "cancel", content: null }),
    }) as { ready: boolean; launched: boolean };
    assert.equal(result.ready, false);
    assert.equal(result.launched, false);
    assert.equal(readLiveSession("TJ-901"), null);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    home.cleanup();
  }
});

it("clear-run n'envoie aucun signal a un PID negatif enregistre dans une vieille session", () => {
  useProjectConfig();
  const registry = loadRegistry();
  const project = sandboxProject({ registry: stringifyStrict({ ...registry, repositories: registry.repositories.map((repo) => ({ ...repo, path: "/nonexistent/autopilot-fixture" })) }) });
  const home = sandboxHome(project.root);
  try {
    patchTicketState("TJ-902", {});
    writeLiveSession({ ticketId: "TJ-902", runId: "r", pid: -1, port: 12001, url: "http://127.0.0.1:12001", startedAt: new Date().toISOString() });
    const script = new URL("../../plugins/autopilot/mcp/scripts/clear-run.ts", import.meta.url).href;
    const code = `let calls=0; process.kill=()=>{calls++; return true}; process.on("exit",()=>{if(calls) process.exitCode=73}); process.argv=[process.execPath,"clear-run.ts","TJ-902","--dry-run"]; await import(${JSON.stringify(script)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally { home.cleanup(); project.cleanup(); }
});
