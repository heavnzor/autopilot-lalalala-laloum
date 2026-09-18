import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { resetEnvCache } from "../../plugins/autopilot/mcp/lib/env.ts";
import { request } from "../../plugins/autopilot/mcp/lib/http.ts";
import { watchPipeline } from "../../plugins/autopilot/mcp/lib/gitlab.ts";
import { fakeGitLab, type FakeGitLab } from "../fixtures/servers.ts";

describe("le transport ne duplique pas une creation incertaine", () => {
  it("ne rejoue pas un POST accepte dont la reponse a ete perdue", async () => {
    let calls = 0;
    const server = createServer((req) => { calls += 1; req.socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      await assert.rejects(() => request(`http://127.0.0.1:${port}/comments`, { method: "POST", body: { text: "unique" } }));
      assert.equal(calls, 1);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("reessaie une lecture transitoirement indisponible", async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls += 1;
      res.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      assert.deepEqual((await request(`http://127.0.0.1:${port}`)).data, { ok: true });
      assert.equal(calls, 2);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});

describe("un vert CI exige tous les jobs requis executes", () => {
  let service: FakeGitLab;
  let previous: NodeJS.ProcessEnv;
  before(async () => {
    previous = { ...process.env };
    service = await fakeGitLab();
    process.env.GITLAB_HOST = service.url;
    process.env.GITLAB_TOKEN = "fixture-token";
    resetEnvCache();
  });
  after(async () => {
    await service.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    resetEnvCache();
  });
  const watch = (expectedSha?: string) => watchPipeline({ projectPath: "fixture/core", ref: "tag", jobs: ["build", "test"], timeoutSeconds: 0.5, pollSeconds: 0.01, expectedSha });
  it("refuse un job manquant", async () => {
    service.pipelineVerdicts.set("tag", { jobs: [{ name: "build", status: "success" }] });
    const result = await watch();
    assert.notEqual(result.verdict, "success");
    assert.deepEqual(result.missingJobs, ["test"]);
  });
  for (const status of ["manual", "skipped", "canceled", "failed"]) {
    it(`refuse un job requis ${status}`, async () => {
      service.pipelineVerdicts.set("tag", { jobs: [{ name: "build", status: "success" }, { name: "test", status }] });
      assert.equal((await watch()).verdict, "failed");
    });
  }
  it("accepte les deux jobs executes avec succes", async () => {
    service.pipelineVerdicts.set("tag", { jobs: [{ name: "build", status: "success" }, { name: "test", status: "success" }] });
    assert.equal((await watch()).verdict, "success");
  });
  it("n'accepte jamais le pipeline d'un autre commit", async () => {
    assert.equal((await watch("abcdef0")).verdict, "no-pipeline");
  });
});
