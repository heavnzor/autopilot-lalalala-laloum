import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfig } from "./config.ts";
import { fail } from "./errors.ts";
import { memoryDir } from "./paths.ts";
import { parseYaml, stringifyStrict } from "./yaml.ts";

/**
 * La memoire est une base de connaissances versionnee dans git, pas un index.
 *
 * En v2 il n'y a volontairement aucun moteur semantique : un filtre
 * deterministe sur le frontmatter plus un grep sur le contenu. C'est exact,
 * gratuit, debuggable, et ca ne peut pas se desynchroniser du disque. On
 * ajoutera un index le jour ou la recherche deterministe ne suffira plus.
 */

export const SCOPES = [
  "company",
  "domain",
  "capability",
  "feature",
  "integration",
  "repo",
  "decision",
  "incident",
  "change",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Une connaissance est stockee au niveau le plus haut ou elle reste vraie. */
export const SCOPE_DIRECTORIES: Readonly<Record<Scope, string>> = {
  company: "company",
  domain: "domains",
  capability: "capabilities",
  feature: "features",
  integration: "integrations",
  repo: "repos",
  decision: "decisions",
  incident: "incidents",
  change: "changes",
};

export interface Frontmatter {
  readonly type: string;
  readonly scope: Scope;
  readonly feature?: string | null;
  readonly last_verified: string;
  readonly repos?: readonly string[];
  readonly source?: { readonly ticket?: string | null; readonly figma?: string | null };
  readonly [key: string]: unknown;
}

export interface Note {
  /** Chemin relatif a `memory/`, c'est l'identifiant d'une note partout ailleurs. */
  readonly path: string;
  readonly frontmatter: Frontmatter;
  readonly body: string;
  readonly lines: number;
}

export interface MemoryQuery {
  readonly scope?: Scope | readonly Scope[];
  readonly feature?: string;
  readonly repos?: readonly string[];
  readonly type?: string;
  readonly pathPrefix?: string;
  readonly grep?: string;
  readonly limit?: number;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseNote(path: string, raw: string): Note {
  const match = FRONTMATTER.exec(raw);
  if (!match?.[1]) {
    fail(`Note sans frontmatter : ${path}.`, "Toute note porte au minimum type, scope et last_verified.");
  }
  const frontmatter = parseYaml<Frontmatter>(match[1]);
  // La serialisation pose une ligne vide apres le frontmatter et une en fin de
  // fichier. Les garder ferait qu'une note relue ne serait plus egale a
  // elle-meme, et le compte de lignes serait faux de deux.
  const body = (match[2] ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
  assertFrontmatter(path, frontmatter);
  return { path, frontmatter, body, lines: countLines(body) };
}

export function serializeNote(frontmatter: Frontmatter, body: string): string {
  const head = stringifyStrict(frontmatter).trimEnd();
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

export function assertFrontmatter(path: string, frontmatter: Frontmatter): void {
  if (!frontmatter || typeof frontmatter !== "object") fail(`Frontmatter illisible : ${path}.`);
  if (!frontmatter.type) fail(`Frontmatter sans \`type\` : ${path}.`);
  if (!SCOPES.includes(frontmatter.scope)) {
    fail(`Scope inconnu dans ${path} : ${String(frontmatter.scope)}.`, `Scopes : ${SCOPES.join(", ")}`);
  }
  if (!frontmatter.last_verified || !/^\d{4}-\d{2}-\d{2}$/.test(String(frontmatter.last_verified))) {
    fail(`\`last_verified\` manquant ou mal forme dans ${path}.`, "Format attendu : AAAA-MM-JJ.");
  }
  const verified = new Date(frontmatter.last_verified);
  if (!Number.isFinite(verified.getTime()) || verified.toISOString().slice(0, 10) !== frontmatter.last_verified) fail(`Date de verification inexistante dans ${path}.`);
  const expected = SCOPE_DIRECTORIES[frontmatter.scope];
  const top = path.split("/")[0];
  if (top !== expected) {
    fail(
      `Note ${path} declaree \`scope: ${frontmatter.scope}\` mais rangee sous \`${top}/\`.`,
      `Attendu sous \`${expected}/\`.`,
    );
  }
}

/**
 * La limite des 100 lignes n'est pas cosmetique : au-dela, un agent ne cite plus
 * la note, il la resume — et le resume derive.
 */
export function assertNoteLength(path: string, body: string): void {
  const max = loadConfig().memory.maxNoteLines;
  const lines = countLines(body);
  if (lines > max) {
    fail(
      `Note trop longue : ${path} fait ${lines} lignes hors frontmatter, la limite est ${max}.`,
      "Scinde-la en notes atomiques plutot que de la tronquer.",
    );
  }
}

export function listNotes(root = memoryDir()): Note[] {
  if (!existsSync(root)) return [];
  const notes: Note[] = [];
  for (const absolute of walk(root)) {
    if (!absolute.endsWith(".md")) continue;
    const relativePath = relative(root, absolute).split(sep).join("/");
    notes.push(parseNote(relativePath, readFileSync(absolute, "utf8")));
  }
  return notes.sort((a, b) => a.path.localeCompare(b.path));
}

export function queryNotes(query: MemoryQuery, root = memoryDir()): Note[] {
  const wantedScopes = query.scope
    ? new Set(Array.isArray(query.scope) ? query.scope : [query.scope])
    : null;
  const wantedRepos = query.repos?.map((r) => r.toLowerCase());
  const needle = query.grep ? new RegExp(query.grep, "i") : null;

  const matched = listNotes(root).filter((note) => {
    if (wantedScopes && !wantedScopes.has(note.frontmatter.scope)) return false;
    if (query.type && note.frontmatter.type !== query.type) return false;
    if (query.feature && String(note.frontmatter.feature ?? "") !== query.feature) return false;
    if (query.pathPrefix && !note.path.startsWith(query.pathPrefix)) return false;
    if (wantedRepos?.length) {
      const declared = (note.frontmatter.repos ?? []).map((r) => String(r).toLowerCase());
      if (!wantedRepos.some((r) => declared.includes(r))) return false;
    }
    if (needle && !needle.test(note.body) && !needle.test(note.path)) return false;
    return true;
  });

  return query.limit ? matched.slice(0, query.limit) : matched;
}

export function notePath(relativePath: string, root = memoryDir()): string {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) fail(`Chemin de note hors de memory/ : ${relativePath}.`);
  const absolute = resolve(root, relativePath);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || absolute === root) {
    fail(`Chemin de note hors de memory/ : ${relativePath}.`);
  }
  if (!absolute.endsWith(".md")) fail(`Une note de memoire est un fichier .md : ${relativePath}.`);
  if (existsSync(root)) {
    let ancestor = absolute;
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    const actual = resolve(realpathSync(ancestor), relative(ancestor, absolute));
    const rel = relative(realpathSync(root), actual);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail(`Lien symbolique hors de memory/ : ${relativePath}.`);
  }
  return absolute;
}

export function writeNote(relativePath: string, frontmatter: Frontmatter, body: string, root = memoryDir()): void {
  const normalized = relativePath.split(sep).join("/");
  assertFrontmatter(normalized, frontmatter);
  assertNoteLength(normalized, body);
  const absolute = notePath(normalized, root);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, serializeNote(frontmatter, body), "utf8");
}

export function deleteNote(relativePath: string, root = memoryDir()): void {
  const absolute = notePath(relativePath.split(sep).join("/"), root);
  if (!existsSync(absolute)) fail(`Note introuvable : ${relativePath}.`);
  rmSync(absolute);
}

export function ensureMemoryLayout(root = memoryDir()): void {
  for (const directory of Object.values(SCOPE_DIRECTORIES)) {
    mkdirSync(join(root, directory), { recursive: true });
  }
}

function countLines(body: string): number {
  const trimmed = body.replace(/\s+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").length;
}

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const absolute = join(directory, entry);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) yield* walk(absolute);
    else yield absolute;
  }
}
