import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { configPathOf, loadConfig, loadRegistry } from "../../plugins/autopilot/mcp/lib/config.ts";
import { run } from "../../plugins/autopilot/mcp/lib/exec.ts";
import { parseYaml, stringifyStrict } from "../../plugins/autopilot/mcp/lib/yaml.ts";
import { PROJECT_ROOT, sandboxProject, useProjectConfig } from "../helpers.ts";

describe("une configuration invalide echoue au chargement", () => {
  useProjectConfig();
  const configuration = parseYaml<any>(readFileSync(configPathOf("autopilot.yaml"), "utf8"));
  const registry = parseYaml<any>(readFileSync(configPathOf("repositories.yaml"), "utf8"));
  it("refuse un budget negatif plutot que de casser un run plus tard", () => {
    const value = structuredClone(configuration);
    value.budgets.codeAdversary = -1;
    const project = sandboxProject({ config: stringifyStrict(value) });
    try { assert.throws(loadConfig, /minimum|>=/); } finally { project.cleanup(); }
  });
  it("refuse une faute de frappe dans un timeout", () => {
    const value = structuredClone(configuration);
    value.timeouts.commandSecond = 30;
    const project = sandboxProject({ config: stringifyStrict(value) });
    try { assert.throws(loadConfig, /additional properties/); } finally { project.cleanup(); }
  });
  it("refuse les noms de depot dupliques", () => {
    const value = structuredClone(registry);
    value.repositories.push(value.repositories[0]);
    const project = sandboxProject({ registry: stringifyStrict(value) });
    try { assert.throws(loadRegistry, /dupliques/); } finally { project.cleanup(); }
  });
  it("refuse une commande qui n'est pas une chaine", () => {
    const value = structuredClone(registry);
    value.repositories[0].commands.ut = true;
    const project = sandboxProject({ registry: stringifyStrict(value) });
    try { assert.throws(loadRegistry); } finally { project.cleanup(); }
  });
  it("refuse une plage de ports inversee", () => {
    const value = structuredClone(configuration);
    value.liveMode.portRange = [13000, 12000];
    const project = sandboxProject({ config: stringifyStrict(value) });
    try { assert.throws(loadConfig, /croissante/); } finally { project.cleanup(); }
  });
});

describe("un runner bavard ne sature pas le serveur", () => {
  it("interrompt la commande et ne rend jamais un faux vert", async () => {
    useProjectConfig();
    const result = await run(`${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(100000))'`, { cwd: PROJECT_ROOT, maxOutputBytes: 1024 });
    assert.equal(result.stoppedBy, "output-limit");
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.stdout.length <= 1024);
    assert.match(result.stderr, /incomplet/);
  });
});
