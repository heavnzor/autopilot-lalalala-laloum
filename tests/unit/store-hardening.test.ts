import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "../../plugins/autopilot/mcp/lib/config.ts";
import { mergePatch, patchTicketState, readTicketState } from "../../plugins/autopilot/mcp/lib/store.ts";
import { sandboxHome } from "../helpers.ts";

describe("la memoire du cadrage ne disparait pas au patch suivant", () => {
  it("conserve les arbitrages successifs au format des prompts historiques", () => {
    const first = { at: "2026-09-18T10:00:00Z", question: "Periode ?", answer: "Mois", why: "Convention" };
    const second = { at: "2026-09-18T10:01:00Z", question: "Invalide ?", answer: "Erreur", why: "Ticket" };
    const state = mergePatch({ arbitrages: { functional: [first] } }, { arbitrages: { functional: [second] } });
    assert.deepEqual(state, { arbitrages: { functional: [first, second] } });
  });
  it("corrige une decision par id sans effacer sa voisine", () => {
    const state = mergePatch([{ id: "a", answer: "avant" }, { id: "b", answer: "stable" }], [{ id: "a", answer: "apres" }]);
    assert.deepEqual(state, [{ id: "a", answer: "apres" }, { id: "b", answer: "stable" }]);
  });
  it("ne fusionne pas les lignes homonymes de deux depots", () => {
    const state = mergePatch([{ id: "T1", repo: "core", status: "pending" }], [{ id: "T1", repo: "app", status: "pending" }]);
    assert.deepEqual(state, [{ id: "T1", repo: "core", status: "pending" }, { id: "T1", repo: "app", status: "pending" }]);
    assert.throws(() => mergePatch(state, [{ id: "T1", status: "passed" }]), /ambigu/);
  });
  it("conserve les listes anonymes, et reserve le remplacement a __replace", () => {
    assert.deepEqual(mergePatch([{ arbitrary: 1 }], [{ arbitrary: 2 }]), [{ arbitrary: 1 }, { arbitrary: 2 }]);
    assert.deepEqual(mergePatch([{ arbitrary: 1 }], { __replace: [] }), []);
  });
  it("refuse la pollution de prototype avant tout merge", () => {
    assert.throws(() => mergePatch({}, JSON.parse('{"__proto__":{"polluted":true}}')));
    assert.equal(({} as any).polluted, undefined);
  });
});

describe("invariants apres fusion et ecritures concurrentes", () => {
  let home: ReturnType<typeof sandboxHome>;
  before(() => { home = sandboxHome(); });
  after(() => home.cleanup());

  it("refuse les enveloppes qui contournent le budget et laisse le disque intact", () => {
    const budget = loadConfig().budgets.codeAdversary;
    patchTicketState("TJ-2000", { scope: [{ name: "fixture", loops: { codeAdversary: budget } }] });
    const before = readTicketState("TJ-2000");
    for (const patch of [
      { scope: [{ name: "fixture", loops: { codeAdversary: { __replace: budget + 1 } } }] },
      { scope: { __replace: [{ name: "fixture", loops: { codeAdversary: budget + 1 } }] } },
      { scope: [{ name: "fixture", loops: { codeAdversary: -1 } }] },
      { scope: [{ name: "fixture", loops: { codeAdversary: 0 } }] },
      { scope: { __replace: [] } },
    ]) assert.throws(() => patchTicketState("TJ-2000", patch));
    assert.deepEqual(readTicketState("TJ-2000"), before);
  });
  it("refuse un curseur invalide meme dans une enveloppe de remplacement", () => {
    assert.throws(() => patchTicketState("TJ-2001", { run: { __replace: { step: "10.99" } } }));
    assert.equal(readTicketState("TJ-2001"), null);
  });
  it("serialise les increments de plusieurs processus sans perte", async () => {
    const module = new URL("../../plugins/autopilot/mcp/lib/store.ts", import.meta.url).href;
    const code = `import {patchTicketState} from ${JSON.stringify(module)}; for(let i=0;i<25;i++) patchTicketState("TJ-2002", {metrics:{humanInterventions:{__increment:1}}});`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    })));
    assert.equal((readTicketState("TJ-2002") as any).metrics.humanInterventions, 100);
  });
});
