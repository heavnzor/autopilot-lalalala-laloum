import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PROJECT_ROOT, sandboxHome } from "../helpers.ts";

it("le vrai serveur MCP expose les outils et valide les appels sur stdio", async () => {
  const sandbox = sandboxHome();
  const client = new Client({ name: "autopilot-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(PROJECT_ROOT, "plugins/autopilot/mcp/server.ts")],
    env: {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      AUTOPILOT_HOME: sandbox.home, AUTOPILOT_PROJECT_ROOT: PROJECT_ROOT,
      AUTOPILOT_ENV_FILE: join(sandbox.home, "absent.env"),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "advance-workflow"));
    assert.ok(tools.tools.some((tool) => tool.name === "create-code-commit"));
    assert.ok(!tools.tools.some((tool) => tool.name === "create-commit"));
    const invalid = await client.callTool({ name: "run-test-ut", arguments: { ticketId: "TJ-1", repo: "web-app", invented: true } });
    assert.equal(invalid.isError, true);
    const state = await client.callTool({ name: "write-store-ticket", arguments: { ticketId: "TJ-1", patch: { run: { step: "2" } } } });
    assert.notEqual(state.isError, true);
    const badCursor = await client.callTool({ name: "write-store-ticket", arguments: { ticketId: "TJ-1", patch: { run: { step: "10.99" } } } });
    assert.equal(badCursor.isError, true);
  } finally {
    await client.close();
    sandbox.cleanup();
  }
});
