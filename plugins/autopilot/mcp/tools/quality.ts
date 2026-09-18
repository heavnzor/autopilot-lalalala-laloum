import { existsSync, globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandKind, type RepoEntry, findRepo, loadConfig, reportPathFor, targetingFor } from "../lib/config.ts";
import { fail } from "../lib/errors.ts";
import { run, stopReason } from "../lib/exec.ts";
import { commandFilter } from "../lib/git.ts";
import { captureRevision, recordVerification } from "../lib/verification.ts";
import { readReceipt, receiptPath } from "../lib/receipts.ts";
import { worktreePath } from "../lib/paths.ts";
import { arr, obj, str } from "../lib/schema.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";

/**
 * Lancer une commande et lire un code de sortie n'a jamais demande un LLM.
 * Ces tools rendent un verdict brut ; ce qu'on paie un modele pour faire, c'est
 * interpreter un echec et le router, jamais lire un `exit 1`.
 */

const KINDS: { kind: CommandKind; tool: string; label: string }[] = [
  { kind: "ut", tool: "run-test-ut", label: "tests unitaires" },
  { kind: "it", tool: "run-test-it", label: "tests d'integration" },
  { kind: "ft", tool: "run-test-ft", label: "tests fonctionnels" },
  { kind: "ct", tool: "run-test-ct", label: "tests de composant" },
  { kind: "e2e", tool: "run-test-e2e", label: "tests de bout en bout" },
  { kind: "lint", tool: "run-lint", label: "lint" },
  { kind: "typecheck", tool: "run-typecheck", label: "typecheck" },
];

export const qualityTools: AnyTool[] = KINDS.map(({ kind, tool, label }) =>
  defineTool({
    name: tool,
    description:
      `Lance les ${label} d'un repo. La commande n'est jamais deduite du runner : elle est lue dans repositories.yaml. ` +
      `Si le repo ne declare pas ce type de verification, le tool le dit au lieu d'inventer une commande.`,
    inputSchema: obj(
      {
        ticketId: str("Cle Jira, elle designe le worktree."),
        repo: str("Nom du repo dans le registre."),
        filter: str("Compatibilite : uniquement --filter=<paquet> (turbo) ou --scope=<paquet> (lerna). Prefere packages."),
        packages: arr("Noms des paquets a verifier, tels que rendus par monorepo-filter. Aucun fragment shell.", str("Nom de paquet.")),
        paths: arr(
          "Fichiers ou motifs a cibler. La facon de les passer au runner est declaree par le repo (`targeting` du registre) : n'invente pas de drapeau, et ne conclus pas d'un refus d'argument que le repo n'est pas ciblable.",
          str("Chemin ou motif."),
        ),
        focus: str(
          "Expression reguliere. La sortie rendue se limite alors aux lignes qui matchent, avec deux lignes de contexte — c'est ce qui permet de lire trois fichiers de tests dans une suite de plusieurs milliers de lignes. Un motif sans resultat ne masque rien : la sortie entiere revient, et `focusMatched` vaut 0.",
        ),
      },
      ["ticketId", "repo"],
    ),
    handler: async (
      input: { ticketId: string; repo: string; filter?: string; packages?: string[]; paths?: string[]; focus?: string },
      context,
    ) => {
      const repo = findRepo(input.repo);
      const filter = commandFilter(repo, input);
      const command = repo.commands?.[kind] ?? null;

      if (!command) {
        return {
          ran: false,
          repo: repo.name,
          kind,
          reason: `Le repo ${repo.name} ne declare pas de commande \`${kind}\`.`,
          note: "Ce n'est pas un echec : ce type de verification n'existe pas ici. N'en invente pas une.",
        };
      }

      const cwd = worktreePath(input.ticketId, repo.name);
      if (!existsSync(cwd)) fail(`Worktree absent : ${cwd}.`, "Appelle create-worktree puis setup-repo.");

      const template = targetingFor(repo, kind);
      if (template === null && input.paths && input.paths.length > 0) {
        fail(
          `Le repo ${repo.name} declare que sa commande \`${kind}\` ne se cible pas par fichier.`,
          "Lance la suite entiere et sers-toi de `focus` pour n'en lire que ce qui te concerne. N'ajoute pas de drapeau a la main : la commande vient du registre.",
        );
      }

      const timeouts = loadConfig().timeouts;
      const targeting = renderTargeting(template ?? "{paths}", input.paths);
      const full = [command, filter, targeting].filter(Boolean).join(" ");
      const before = await captureRevision(cwd);
      const approvedBefore = readReceipt<{ fingerprint: string }>(receiptPath(input.ticketId, "approval.json"))?.fingerprint ?? null;
      const result = await run(full, {
        cwd,
        timeoutMs: timeouts.commandSeconds * 1000,
        silenceMs: timeouts.commandSilenceSeconds * 1000,
        focus: input.focus,
        logTo: `${input.ticketId}-${repo.name}-${kind}`,
        // Un test long est legitime ; un appel MCP muet ne l'est pas. Le
        // battement porte la difference jusqu'au client, qui sinon tue l'appel
        // et laisse l'agent avec un timeout qu'il ne sait pas interpreter.
        onProgress: (message) => context.heartbeat(`${repo.name} ${kind} — ${message}`),
      });
      const after = await captureRevision(cwd);
      const approvedAfter = readReceipt<{ fingerprint: string }>(receiptPath(input.ticketId, "approval.json"))?.fingerprint ?? null;
      const stable = Boolean(before?.clean && after?.clean && before.sha === after.sha && approvedBefore === approvedAfter);
      const verification = {
        sha: after?.sha ?? null,
        passed: result.exitCode === 0 && stable,
        full: !filter && !input.paths?.length,
        command,
        at: new Date().toISOString(),
        durationMs: result.durationMs,
        planFingerprint: approvedBefore,
      };
      recordVerification(input.ticketId, repo.name, kind, verification);

      const report = result.exitCode === 0 ? null : readReport(repo, kind, cwd);
      const note = advice(result, repo, kind);

      return {
        ran: true,
        repo: repo.name,
        kind,
        command: full,
        passed: result.exitCode === 0,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stoppedBy: result.stoppedBy,
        abandonedBecause: stopReason(result),
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        logPath: result.logPath,
        focusMatched: result.focusMatched,
        verification,
        ...(report ? { report } : {}),
        ...(note ? { advice: note } : {}),
      };
    },
  }),
);

/**
 * Poser les chemins la ou le runner les attend.
 *
 * Empiler des chemins en fin de commande marche sur vitest et sur jest. Ca ne
 * marche pas sur `mtr`, qui refuse tout positionnel et veut un `-g`. Le
 * registre dit lequel des deux ; ici on se contente de remplir le gabarit.
 *
 * Les motifs sont quotes : `shell: true` sinon developpe `*` avant que le
 * runner ne le voie, et le glob revient en dix positionnels sur un binaire qui
 * n'en accepte aucun.
 */
export function renderTargeting(template: string, paths: readonly string[] | undefined): string {
  // Pas de chemin, pas de ciblage : le gabarit ne doit pas laisser un `-g` nu
  // dans la commande, qui ferait alors tourner le glob par defaut du runner.
  if (!paths || paths.length === 0) return "";
  for (const path of paths) {
    if (!path || /^[\/-]/.test(path) || /[\0\r\n\\]/.test(path) || path.split("/").includes("..")) {
      fail(`Cible de test invalide : ${JSON.stringify(path)}.`, "Un chemin relatif ou un glob, jamais un drapeau ni un chemin hors du depot.");
    }
  }
  const glob = paths.length === 1 ? (paths[0] ?? "") : `{${paths.join(",")}}`;
  return template
    .replaceAll("{paths}", paths.map(quote).join(" "))
    .replaceAll("{glob}", quote(glob));
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Ce qu'on dit a l'agent quand la sortie rendue n'est pas la sortie complete.
 *
 * Sans cette phrase, un checker fait ce qu'il a fait sur FT-1042 : il constate
 * qu'il ne voit pas ses tests, en conclut que le repo n'est pas observable, et
 * escalade. Les deux sorties de secours existent, il faut les nommer.
 */
function advice(
  result: { truncated: boolean; logPath: string | null; focusMatched: number | null },
  repo: RepoEntry,
  kind: CommandKind,
): string | null {
  if (result.focusMatched === 0) {
    return "Ton motif `focus` n'a trouve aucune ligne : la sortie rendue est la sortie entiere, pas un resultat filtre. Elargis le motif avant d'en conclure quoi que ce soit.";
  }
  if (!result.truncated) return null;
  const targeted = typeof repo.targeting?.[kind] === "string";
  return (
    "La sortie rendue est coupee au milieu. Deux facons de voir la partie manquante, dans cet ordre : " +
    "relancer avec `focus` sur le nom de tes fichiers de test, ce qui garde les lignes qui matchent au lieu des deux bouts" +
    (targeted ? ", ou avec `paths` — ce repo declare comment se cibler" : "") +
    (result.logPath ? ` ; la sortie complete est de toute facon sur disque : ${result.logPath}` : "") +
    ". Une sortie coupee n'est pas un repo inobservable : ne l'escalade pas avant d'avoir essaye les deux."
  );
}

interface Diagnostic {
  readonly file: string;
  readonly line: number | null;
  readonly severity: string;
  readonly rule: string;
  readonly message: string;
}

interface Report {
  readonly from: readonly string[];
  readonly total: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly truncated: boolean;
  readonly note: string;
}

/** Au dela, on ne lit plus un rapport, on subit un dump. */
const MAX_DIAGNOSTICS = 60;

/**
 * Le diagnostic est dans un fichier, pas sur la sortie.
 *
 * Une commande de qualite redirige souvent son rapport — `biome ci
 * --reporter=gitlab > code-quality.json`. Le tool voit alors un `exit 1` et
 * zero ligne, et l'agent n'a plus que la lecture manuelle pour savoir ce qui a
 * casse : sur FT-1042, deux heures de run y sont passees avant que la session
 * soit tuee. Le registre dit ou le rapport atterrit ; on le lit ici.
 */
function readReport(repo: RepoEntry, kind: CommandKind, cwd: string): Report | null {
  const pattern = reportPathFor(repo, kind);
  if (!pattern) return null;

  let files: string[];
  try {
    files = globSync(pattern, { cwd }).sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;

  const diagnostics: Diagnostic[] = [];
  const read: string[] = [];
  for (const file of files) {
    const parsed = parseReport(join(cwd, file));
    if (!parsed) continue;
    read.push(file);
    diagnostics.push(...parsed);
  }
  if (read.length === 0) return null;

  const kept = diagnostics.slice(0, MAX_DIAGNOSTICS);
  return {
    from: read,
    total: diagnostics.length,
    diagnostics: kept,
    truncated: diagnostics.length > kept.length,
    note:
      `La commande ecrit son rapport dans ${pattern}, pas sur sa sortie. ` +
      "Ces lignes viennent du fichier : inutile de les rechercher a la main.",
  };
}

/**
 * Le format CodeClimate, celui que `--reporter=gitlab` produit et que GitLab
 * lit. On ne tente rien d'autre : un rapport qu'on ne reconnait pas est rendu
 * absent, pas devine.
 */
function parseReport(path: string): Diagnostic[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  return parsed.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as {
      description?: unknown;
      check_name?: unknown;
      severity?: unknown;
      location?: { path?: unknown; lines?: { begin?: unknown } };
    };
    return [
      {
        file: typeof item.location?.path === "string" ? item.location.path : "?",
        line: typeof item.location?.lines?.begin === "number" ? item.location.lines.begin : null,
        severity: typeof item.severity === "string" ? item.severity : "unknown",
        rule: typeof item.check_name === "string" ? item.check_name : "?",
        message: typeof item.description === "string" ? item.description : "",
      },
    ];
  });
}
