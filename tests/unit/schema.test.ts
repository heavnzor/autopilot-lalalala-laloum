import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { arr, num, obj, str, validate } from "../../plugins/autopilot/mcp/lib/schema.ts";
import { commandFilter } from "../../plugins/autopilot/mcp/lib/git.ts";
import { findRepo } from "../../plugins/autopilot/mcp/lib/config.ts";
import { ticketStatePath, worktreePath } from "../../plugins/autopilot/mcp/lib/paths.ts";
import { renderTargeting } from "../../plugins/autopilot/mcp/tools/quality.ts";
import { isJsonValue } from "../../shared/json.ts";
import { useProjectConfig } from "../helpers.ts";

describe("les schemas annonces sont effectivement appliques", () => {
  const schema = obj({
    key: str("Cle", { minLength: 2, pattern: "^[A-Z]+$" }),
    count: num("Compteur", { type: "integer", minimum: 0, maximum: 3 }),
    entries: arr("Entrees", obj({ id: str("Identifiant") }, ["id"]), { minItems: 1, uniqueItems: true }),
  }, ["key", "count", "entries"]);
  const valid = { key: "TJ", count: 1, entries: [{ id: "a" }] };

  it("accepte une entree conforme sans la modifier", () => {
    validate(schema, valid);
    assert.deepEqual(valid, { key: "TJ", count: 1, entries: [{ id: "a" }] });
  });
  for (const [name, patch] of Object.entries({
    "champ inconnu": { bypass: true }, "borne": { count: 4 }, "fraction": { count: 0.5 },
    "infini": { count: Infinity }, "motif": { key: "../etc" }, "longueur": { key: "T" },
    "liste vide": { entries: [] }, "champ imbrique": { entries: [{ id: "a", bypass: true }] },
    "doublon": { entries: [{ id: "a" }, { id: "a" }] }, "null non admis": { key: null },
  })) {
    it(`refuse ${name}`, () => assert.throws(() => validate(schema, { ...valid, ...patch })));
  }
});

describe("aucun filtre agent ne devient une commande shell", () => {
  useProjectConfig();
  const repo = findRepo("web-app");
  it("accepte les paquets structures et les anciens drapeaux valides", () => {
    assert.equal(commandFilter(repo, { packages: ["@acme/web", "@acme/web"] }), "--filter=@acme/web");
    assert.equal(commandFilter(repo, { filter: "--filter=@acme/web --filter=helpers" }), "--filter=@acme/web --filter=helpers");
  });
  for (const filter of ["; true", "--filter=web;true", "--filter=$(true)", "--filter=web && true", "--help", "--scope=web", "--filter=web\ntrue"]) {
    it(`refuse ${JSON.stringify(filter)}`, () => assert.throws(() => commandFilter(repo, { filter })));
  }
  it("refuse aussi une injection dans les noms structures", () => {
    assert.throws(() => commandFilter(repo, { packages: ["web;true"] }));
  });
  it("ne transforme pas les cibles en drapeaux", () => {
    for (const path of ["--help", "../other/test.ts", "/tmp/test.ts", "a\nb"]) {
      assert.throws(() => renderTargeting("{paths}", [path]));
    }
  });
});

describe("les chemins et les valeurs restent dans leur contrat", () => {
  it("normalise la casse d'une cle, et refuse un chemin a sa place", () => {
    assert.equal(ticketStatePath("tj-12"), ticketStatePath("TJ-12"));
    assert.throws(() => ticketStatePath("../../other"));
    assert.throws(() => worktreePath("TJ-12", "../other"));
  });
  it("refuse les objets qui changeraient de sens en JSON", () => {
    for (const value of [new Date(), new Map(), undefined, NaN, Infinity, { missing: undefined }]) {
      assert.equal(isJsonValue(value), false);
    }
    const cycle: any = {};
    cycle.self = cycle;
    assert.equal(isJsonValue(cycle), false);
    assert.equal(isJsonValue({ data: [null, true, 0, "ok"] }), true);
  });
});
