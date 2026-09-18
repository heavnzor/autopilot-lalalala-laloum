import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonValue, type JsonValue } from "../../../../shared/json.ts";
import { loadConfig, squadOf } from "./config.ts";
import { fail } from "./errors.ts";
import { autopilotHome, ticketKey, ticketStatePath } from "./paths.ts";
import { withFileMutex } from "./mutex.ts";
import { parseYaml, stringifyStrict } from "./yaml.ts";

export type Json = JsonValue;

/**
 * L'etat d'un ticket est la machine a etats du run. Plusieurs agents y ecrivent
 * pendant le meme run, et aucun n'a le contexte complet : un ecrasement en
 * remplacement total serait le bug le plus cher du systeme, parce qu'il est
 * silencieux et qu'on ne le voit qu'a la reprise.
 *
 * D'ou un merge/patch, avec trois regles et une echappatoire :
 *
 * - objet contre objet     -> fusion en profondeur
 * - liste d'objets         -> fusion par identite (`name`, `id`, `repo`, ...),
 *                             les entrees inconnues sont ajoutees a la fin
 * - liste de scalaires     -> union, dans l'ordre, sans doublon
 * - `null` dans le patch   -> efface explicitement le champ
 * - `{ __replace: [...] }` -> remplace la valeur telle quelle, quand c'est
 *                             vraiment ce qu'on veut (une reinitialisation)
 * - `{ __increment: 1 }`   -> ajoute au nombre existant. Un compteur qu'on
 *                             ecrit en valeur absolue est faux des que deux
 *                             agents l'incrementent sans se voir, et c'est
 *                             exactement le cas des compteurs de boucle et
 *                             des interventions humaines
 *
 * Absent du patch ne veut jamais dire « vide » : ca veut dire « je n'en sais
 * rien », et le champ existant survit.
 */

const IDENTITY_KEYS = ["id", "name", "repo", "test", "note", "url", "key", "question", "path", "pass"] as const;
const REPLACE_SENTINEL = "__replace";
const INCREMENT_SENTINEL = "__increment";

export function mergePatch(base: Json, patch: Json): Json {
  assertSafeJson(patch);
  if (isReplaceEnvelope(patch)) return patch[REPLACE_SENTINEL] as Json;
  if (isIncrementEnvelope(patch)) {
    const step = patch[INCREMENT_SENTINEL];
    return (typeof base === "number" ? base : 0) + step;
  }
  if (patch === null) return null;
  if (Array.isArray(patch)) return mergeArrays(Array.isArray(base) ? base : [], patch);
  if (isPlainObject(patch)) {
    const target: Record<string, Json> = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
      target[key] = mergePatch(target[key] ?? null, value);
    }
    return target;
  }
  return patch;
}

function mergeArrays(base: Json[], patch: Json[]): Json[] {
  const patchHasObjects = patch.some(isPlainObject);
  if (!patchHasObjects) {
    // Union de scalaires : les commits du developer s'empilent, ils ne se
    // remplacent pas. Un agent qui ne connait qu'un commit n'efface pas les
    // autres.
    const seen = new Set<string>();
    const out: Json[] = [];
    for (const item of [...base, ...patch]) {
      const token = JSON.stringify(item);
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(item);
    }
    return out;
  }

  const identity = identityKeyOf(patch) ?? identityKeyOf(base);
  // Une liste anonyme s'empile elle aussi. Son remplacement doit etre explicite :
  // le cadrage ecrit ses arbitrages par petits lots, pas par snapshots complets.
  if (!identity) {
    const out = [...base];
    for (const item of patch) {
      const resolved = mergePatch(null, item);
      if (!out.some((entry) => JSON.stringify(entry) === JSON.stringify(resolved))) out.push(resolved);
    }
    return out;
  }

  const out: Json[] = base.map((item) => item);
  for (const item of patch) {
    if (!isPlainObject(item)) {
      out.push(item);
      continue;
    }
    const id = item[identity];
    const matches = out.flatMap((candidate, index) => {
      if (!isPlainObject(candidate) || candidate[identity] !== id) return [];
      if (identity === "id" && item.repo !== undefined && candidate.repo !== undefined && item.repo !== candidate.repo) return [];
      return [index];
    });
    if (matches.length > 1) fail(`Identifiant de liste ambigu : ${String(id)}.`, "Precise aussi repo dans le patch.");
    const index = matches[0] ?? -1;
    // Une entree neuve passe par le merge comme les autres, contre une base
    // vide. Poussee telle quelle, elle garderait ses enveloppes en l'etat : le
    // premier tour d'une boucle sur un repo neuf ecrivait `{__increment: 1}` la
    // ou le compteur attend `1`, et ce compteur-la n'est plus jamais juste.
    if (index === -1) out.push(mergePatch(null, item));
    else out[index] = mergePatch(out[index] ?? null, item);
  }
  return out;
}

function identityKeyOf(items: readonly Json[]): string | null {
  const objects = items.filter(isPlainObject);
  if (objects.length === 0) return null;
  for (const key of IDENTITY_KEYS) {
    if (objects.every((item) => typeof item[key] === "string" || typeof item[key] === "number")) {
      return key;
    }
  }
  return null;
}

function isPlainObject(value: Json): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplaceEnvelope(value: Json): value is { [REPLACE_SENTINEL]: Json } {
  return isPlainObject(value) && REPLACE_SENTINEL in value && Object.keys(value).length === 1;
}

function isIncrementEnvelope(value: Json): value is { [INCREMENT_SENTINEL]: number } {
  return (
    isPlainObject(value) &&
    INCREMENT_SENTINEL in value &&
    Object.keys(value).length === 1 &&
    typeof value[INCREMENT_SENTINEL] === "number"
  );
}

// --------------------------------------------------------------- fichier ----

export function readTicketState(ticketId: string): Json | null {
  try {
    return parseYaml<Json>(readFileSync(ticketStatePath(ticketId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function ticketStateExists(ticketId: string): boolean {
  return readTicketState(ticketId) !== null;
}

/**
 * Ecriture atomique : fichier temporaire puis `rename`. Un run tue en plein
 * milieu d'une ecriture ne doit pas laisser un etat tronque — ce serait la
 * seule facon de rendre un ticket irreprenable.
 */
export function patchTicketState(ticketId: string, patch: Json, expected?: { step: string; repo: string | null }): Json {
  const key = ticketKey(ticketId);
  return withFileMutex(join(autopilotHome(), "locks", `state-${key}.lock`), () => {
    const path = ticketStatePath(key);
    const base = readTicketState(key) ?? emptyTicketState(key);
    if (expected) {
      const run = isPlainObject(base) && isPlainObject(base.run ?? null) ? base.run as Record<string, Json> : {};
      if (String(run.step) !== expected.step || (run.currentRepo ?? null) !== expected.repo) {
        fail("Le curseur a deja change : transition refusee.", "Relis get-store-ticket avant de router un autre verdict.");
      }
    }
    const merged = mergePatch(base, patch);
    validateTicketState(key, merged, base);
    const state = merged as Record<string, Json>;
    state.run = { ...(state.run as Record<string, Json>), updatedAt: new Date().toISOString() };
    state.schemaVersion = 1;

    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, stringifyStrict(state), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
    return state;
  });
}

function assertSafeJson(value: Json): void {
  if (!isJsonValue(value)) fail("L'etat doit etre un JSON fini et serialisable.");
  const walk = (entry: Json): void => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail(`Cle d'etat interdite : ${key}.`);
      walk(child);
    }
  };
  walk(value);
}

/** Validation du resultat, apres resolution de TOUTES les enveloppes de patch. */
export function validateTicketState(ticketId: string, value: Json, previous: Json): void {
  assertSafeJson(value);
  if (!isPlainObject(value) || !isPlainObject(value.run ?? null) || !Array.isArray(value.scope)) {
    fail("L'etat doit porter un objet run et une liste scope.");
  }
  const run = value.run as Record<string, Json>;
  const step = String(run.step ?? "").trim();
  if (!/^(?:[1-9]|10(?:\.[1-7])?|11|12|13)$/.test(step)) fail(`\`run.step\` invalide : ${step}.`);
  run.step = step;
  if (!isPlainObject(value.ticket ?? null) || (value.ticket as Record<string, Json>).key !== ticketId) {
    fail("La cle du ticket ne peut pas changer pendant un run.");
  }
  const budgets = loadConfig().budgets as unknown as Record<string, number | undefined>;
  const oldScope = isPlainObject(previous) && Array.isArray(previous.scope) ? previous.scope : [];
  let turns = 0;
  const names = new Set<string>();
  for (const entry of value.scope) {
    if (!isPlainObject(entry)) fail("Chaque entree scope doit etre un objet.");
    const name = String(entry.name ?? entry.repo ?? "");
    if (!name || names.has(name)) fail(`Depot absent ou duplique dans le scope : ${name}.`);
    names.add(name);
    const loops = entry.loops ?? {};
    if (!isPlainObject(loops)) fail(`Compteurs invalides pour ${name}.`);
    for (const [loop, count] of Object.entries(loops)) {
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) fail(`Compteur ${name}.${loop} invalide.`);
      const budget = budgets[loop];
      if (typeof budget === "number" && count > budget) {
        fail(
          `\`${loop}\` passerait a ${count} sur ${name}, pour un budget de ${budget}.`,
          "Appelle `escalate-to-human`. Si la boucle n'a pas rendu de verdict, elle ne se debite pas : escalade avec cause environment.",
        );
      }
      turns += count;
    }
  }
  for (const entry of oldScope) {
    if (!isPlainObject(entry) || !isPlainObject(entry.loops ?? null)) continue;
    const current = value.scope.find((item) => isPlainObject(item) && (item.name ?? item.repo) === (entry.name ?? entry.repo));
    const loops = isPlainObject(current ?? null) && isPlainObject((current as Record<string, Json>).loops ?? null)
      ? ((current as Record<string, Json>).loops as Record<string, Json>) : {};
    for (const [loop, before] of Object.entries(entry.loops as Record<string, Json>)) {
      if (typeof before === "number" && Number(loops[loop] ?? 0) < before) fail(`Le compteur ${loop} ne peut pas reculer.`, "Un nouveau run se cree avec clear-run, pas en effacant ses budgets.");
    }
  }
  if (!isPlainObject(value.metrics ?? null)) fail("metrics doit rester un objet.");
  const metrics = value.metrics as Record<string, Json>;
  metrics.loopTurnsTotal = turns;
  for (const key of ["humanInterventions", "mrFeedbackCount"]) {
    const count = metrics[key];
    if (count !== null && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) fail(`Compteur metrics.${key} invalide.`);
  }
}

/**
 * Le squelette complet des le premier ecrit. Les champs du workflow 2 sont la
 * des la v2 : le jour ou on le branche, aucun ticket deja traite n'a besoin
 * d'etre migre.
 */
export function emptyTicketState(ticketId: string): Json {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    ticket: {
      key: ticketId,
      squad: squadOf(ticketId),
      type: null,
      title: null,
      slug: null,
      url: null,
      statusAtStart: null,
      notes: null,
      // Ce que le run a lu du ticket, garde ici parce que Jira n'est pas
      // toujours joignable et qu'un run se relit des semaines plus tard. Sans
      // ca, l'interface montre les decisions sans jamais montrer l'enonce.
      description: null,
      acceptanceCriteria: null,
    },
    figmaOverrides: [],
    run: {
      phase: "cadrage",
      step: "1",
      currentRepo: null,
      liveRunId: null,
      startedAt: now,
      updatedAt: now,
      escalation: null,
    },
    // `urls` sont les references brutes ; `frames` ce que le run en a
    // reellement tire — un nom, une arborescence, et le PNG sur disque.
    figma: { urls: [], frames: [] },
    arbitrages: { functional: [], technical: [] },
    plan: { approvedAt: null, content: null, repos: [], checklists: { tests: [], code: [] } },
    scope: [],
    // `scouted` : les deux passages du doc-scout, large puis cible.
    // `operations` : ce que le memory-writer a applique au point 12.
    memory: { contradictions: [], scouted: [], operations: [], commit: null },
    publication: {
      mergeRequests: [],
      slackChannel: { id: null, name: null, invited: [] },
      jiraTransition: { to: null, at: null },
    },
    metrics: { humanInterventions: 0, loopTurnsTotal: 0, mrFeedbackCount: null },
    workflow2: { feedback: [], lastScannedAt: null, archivedAt: null },
  };
}
