#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadRegistry, repoRoot } from "../lib/config.ts";
import { liveSessionPath, readLiveSession } from "../lib/events.ts";
import { autopilotHome, eventsPath, figmaDir, lockPath, ticketStatePath, worktreePath } from "../lib/paths.ts";
import { readTicketState } from "../lib/store.ts";
import { normalizeKey } from "../lib/ticket.ts";
import { receiptPath } from "../lib/receipts.ts";

/**
 * Efface tout l'etat local d'un run pour qu'un ticket reparte de zero.
 *
 * Ce que le script assume et ce qu'il refuse tient en une phrase : il supprime
 * ce que l'autopilot a ecrit sur cette machine, il ne touche a rien de ce qui
 * est parti sur un remote. Une MR, un tag pousse, un canal slack, une
 * transition Jira survivent au nettoyage — ils se defont a la main, et le
 * script les liste pour qu'on sache lesquels.
 *
 * Le garde-fou est ailleurs : un worktree sale ou une branche qui porte des
 * commits non pousses est du travail que personne d'autre ne detient. Le script
 * s'arrete devant, sans rien avoir efface, et `--force` est la seule facon de
 * passer outre.
 */

interface Removal {
  readonly what: string;
  readonly path: string;
}

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => !arg.startsWith("--"));

if (positional.length !== 1) {
  console.error("usage : node plugins/autopilot/mcp/scripts/clear-run.ts <ticket> [--force] [--dry-run]");
  console.error("        <ticket> est une cle Jira ou l'URL du ticket.");
  process.exit(2);
}

const ticket = normalizeKey(positional[0] ?? "");

function git(cwd: string, gitArgs: readonly string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: out.trim() };
  } catch (error) {
    const shell = error as { stderr?: Buffer | string };
    return { ok: false, out: String(shell?.stderr ?? error).trim() };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/* Etat du run, s'il en reste un. Il sert a dire ce qui a ete publie. */

const state = asRecord(readTicketState(ticket));
const publication = asRecord(state?.publication);
const runCursor = asRecord(state?.run);
const scope = Array.isArray(state?.scope) ? (state.scope as unknown[]) : [];

const remoteTraces: string[] = [];
const mergeRequests = Array.isArray(publication?.mergeRequests) ? publication.mergeRequests : [];
for (const entry of mergeRequests) {
  const mr = asRecord(entry);
  if (mr) remoteTraces.push(`MR ${mr.repo ?? "?"} : ${mr.url ?? mr.iid ?? "?"}`);
}
const slackChannel = asRecord(publication?.slackChannel);
if (slackChannel?.name) remoteTraces.push(`canal slack #${slackChannel.name}`);
const jiraTransition = asRecord(publication?.jiraTransition);
if (jiraTransition?.to) remoteTraces.push(`ticket Jira passe a ${jiraTransition.to}`);
const memory = asRecord(state?.memory);
if (memory?.commit) remoteTraces.push(`commit memoire ${memory.commit}`);
for (const entry of scope) {
  const repo = asRecord(entry);
  const tags = Array.isArray(repo?.tags) ? repo.tags : [];
  for (const tag of tags) remoteTraces.push(`tag ${repo?.repo ?? "?"} : ${String(tag)}`);
}

/* Worktrees du ticket, et ce qu'ils portent encore. */

const worktreeRoot = join(autopilotHome(), "worktrees", ticket);
const worktrees = existsSync(worktreeRoot)
  ? readdirSync(worktreeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  : [];

const blockers: string[] = [];
const dirtyWorktrees: { repo: string; path: string }[] = [];

for (const name of worktrees) {
  const path = worktreePath(ticket, name);
  const status = git(path, ["status", "--porcelain"]);
  const dirty = status.ok && status.out !== "";
  dirtyWorktrees.push({ repo: name, path });
  if (dirty) {
    const count = status.out.split("\n").length;
    blockers.push(`worktree sale : ${path} (${count} fichier${count > 1 ? "s" : ""} non commite${count > 1 ? "s" : ""})`);
  }
}

/* Branches locales du ticket, dans chaque repo du registre. */

interface Branch {
  readonly repo: string;
  readonly source: string;
  readonly name: string;
  readonly ahead: number;
}

const branches: Branch[] = [];
let registryReadable = true;

try {
  for (const repo of loadRegistry().repositories) {
    const source = repoRoot(repo);
    if (!existsSync(join(source, ".git"))) continue;

    const listed = git(source, ["branch", "--list", `*${ticket}*`, "--format=%(refname:short)"]);
    if (!listed.ok || listed.out === "") continue;

    for (const name of listed.out.split("\n").map((line) => line.trim()).filter(Boolean)) {
      const tracked = git(source, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]).ok;
      const against = tracked ? `origin/${name}..${name}` : `origin/${repo.baseBranch}..${name}`;
      const counted = git(source, ["rev-list", "--count", against]);
      const ahead = counted.ok ? Number.parseInt(counted.out, 10) || 0 : 0;
      branches.push({ repo: repo.name, source, name, ahead });
      if (ahead > 0) {
        blockers.push(`branche non poussee : ${repo.name} ${name} (${ahead} commit${ahead > 1 ? "s" : ""} d'avance)`);
      }
    }
  }
} catch (error) {
  registryReadable = false;
  console.error(`! registre illisible, les branches locales ne seront pas nettoyees : ${(error as Error).message}`);
}

/* Fichiers d'etat. */

const removals: Removal[] = [];
const live = readLiveSession(ticket);

if (existsSync(ticketStatePath(ticket))) removals.push({ what: "etat du ticket", path: ticketStatePath(ticket) });
if (existsSync(lockPath(ticket))) removals.push({ what: "lock de run", path: lockPath(ticket) });
if (existsSync(eventsPath(ticket))) removals.push({ what: "journal d'events", path: eventsPath(ticket) });
if (existsSync(liveSessionPath(ticket))) removals.push({ what: "session live", path: liveSessionPath(ticket) });
if (existsSync(figmaDir(ticket))) removals.push({ what: "maquettes rendues", path: figmaDir(ticket) });
if (existsSync(worktreeRoot)) removals.push({ what: "worktrees", path: worktreeRoot });
// Les preuves locales doivent etre refaites. Les journaux d'effets distants
// restent : clear ne doit pas transformer une reprise en double publication.
const receipts = receiptPath(ticket);
if (existsSync(receipts)) {
  for (const entry of readdirSync(receipts)) {
    if (entry.startsWith("operation-") || entry === "slack-channel.json") continue;
    removals.push({ what: "preuve locale a renouveler", path: join(receipts, entry) });
  }
}

/* Rapport. */

console.log(`autopilot — nettoyage du run ${ticket}${dryRun ? " (a blanc)" : ""}`);
console.log("");

if (runCursor) {
  console.log(`  run interrompu en phase ${runCursor.phase ?? "?"}, etape ${runCursor.step ?? "?"}${runCursor.currentRepo ? `, repo ${runCursor.currentRepo}` : ""}`);
}
if (!state && worktrees.length === 0 && removals.length === 0 && branches.length === 0) {
  console.log("  rien a nettoyer : aucun etat local pour ce ticket.");
  process.exit(0);
}

if (blockers.length > 0 && !force) {
  console.log("");
  console.log("  Rien n'a ete supprime. Ce run porte du travail que personne d'autre ne detient :");
  for (const blocker of blockers) console.log(`    x ${blocker}`);
  console.log("");
  console.log("  Sauve ce qui merite de l'etre, puis relance avec --force si la perte est assumee.");
  process.exit(1);
}

if (blockers.length > 0) {
  console.log("  --force : la perte suivante est assumee");
  for (const blocker of blockers) console.log(`    ! ${blocker}`);
  console.log("");
}

/* Suppression. */

function remove(path: string): void {
  if (dryRun) return;
  rmSync(path, { recursive: true, force: true });
}

if (live && Number.isSafeInteger(live.pid) && live.pid > 1) {
  const alive = (() => {
    try {
      process.kill(live.pid, 0);
      return true;
    } catch {
      return false;
    }
  })();
  if (alive) {
    if (!dryRun) {
      try {
        process.kill(live.pid, "SIGTERM");
      } catch {
        /* le shell a pu mourir entre la verification et le signal */
      }
    }
    console.log(`  - live shell (pid ${live.pid}, ${live.url ?? "port inconnu"})`);
  }
}

for (const { repo, path } of dirtyWorktrees) {
  const entry = registryReadable ? loadRegistry().repositories.find((candidate) => candidate.name === repo) : undefined;
  if (entry && !dryRun) {
    const source = repoRoot(entry);
    git(source, ["worktree", "remove", path, "--force"]);
    git(source, ["worktree", "prune"]);
  }
  console.log(`  - worktree ${repo} : ${path}`);
}

for (const branch of branches) {
  if (!dryRun) git(branch.source, ["branch", "-D", branch.name]);
  console.log(`  - branche locale ${branch.repo} : ${branch.name}`);
}

for (const removal of removals) {
  remove(removal.path);
  console.log(`  - ${removal.what} : ${removal.path}`);
}

console.log("");

if (remoteTraces.length > 0) {
  console.log("  Ce qui reste en place, hors de cette machine — a defaire a la main si besoin :");
  for (const trace of remoteTraces) console.log(`    . ${trace}`);
  console.log("");
}

if (dryRun) {
  console.log("  Essai a blanc : rien n'a ete supprime, tout ce qui precede l'aurait ete.");
} else {
  console.log(`  ${ticket} repart de zero sur le disque.`);
  console.log("");
  console.log("  Relance le run dans une SESSION NEUVE — /clear, puis /autopilot-start.");
  console.log("  Une session qui a deja tourne sur ce ticket garde le cadrage en contexte :");
  console.log("  elle le reinjecte sans que rien sur le disque ne le lui demande, et le run");
  console.log("  repart sur des conclusions que plus aucun fichier ne porte.");
}
