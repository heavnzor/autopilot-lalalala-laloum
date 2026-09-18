import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { HttpError } from "../../plugins/autopilot/mcp/lib/http.ts";
import { publishOnce } from "../../plugins/autopilot/mcp/lib/operations.ts";
import { sandboxHome } from "../helpers.ts";

describe("journal de publication", () => {
  let home: ReturnType<typeof sandboxHome>;
  before(() => { home = sandboxHome(); });
  after(() => home.cleanup());

  it("rejoue un resultat confirme sans reposter", async () => {
    let count = 0;
    const execute = async () => ({ id: ++count });
    assert.deepEqual(await publishOnce("TJ-1", "comment", { text: "bonjour" }, execute), { id: 1 });
    assert.deepEqual(await publishOnce("TJ-1", "comment", { text: "bonjour" }, execute), { id: 1 });
    assert.equal(count, 1);
    await assert.rejects(() => publishOnce("TJ-1", "comment", { text: "autre" }, execute), /autre contenu/);
  });
  it("ne rejoue jamais automatiquement un resultat incertain", async () => {
    let count = 0;
    const execute = async () => { count += 1; throw new HttpError("reseau coupe", null, null, true); };
    await assert.rejects(() => publishOnce("TJ-2", "comment", {}, execute));
    await assert.rejects(() => publishOnce("TJ-2", "comment", {}, execute), /incertain/);
    assert.equal(count, 1);
  });
  it("autorise la reprise d'une requete explicitement refusee", async () => {
    await assert.rejects(() => publishOnce("TJ-3", "comment", {}, async () => { throw new HttpError("interdit", null, 403, false); }));
    assert.deepEqual(await publishOnce("TJ-3", "comment", {}, async () => ({ id: 7 })), { id: 7 });
  });
  it("ne lance pas deux creations concurrentes", async () => {
    let finish!: (value: { id: number }) => void;
    const first = publishOnce("TJ-4", "comment", {}, () => new Promise<{ id: number }>((resolve) => { finish = resolve; }));
    let duplicate = false;
    await assert.rejects(() => publishOnce("TJ-4", "comment", {}, async () => { duplicate = true; return { id: 2 }; }), /incertain/);
    finish({ id: 1 });
    assert.deepEqual(await first, { id: 1 });
    assert.equal(duplicate, false);
  });
});
