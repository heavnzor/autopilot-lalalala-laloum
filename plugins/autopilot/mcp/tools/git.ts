import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { findRepo, loadConfig, type RepoEntry, repoRoot } from "../lib/config.ts";
import { fail } from "../lib/errors.ts";
import { expandTilde } from "../lib/paths.ts";
import { run } from "../lib/exec.ts";
import {
  changedFiles,
  filterFlags,
  git,
  gitAllowFailure,
  headSha,
  installCommand,
  listTags,
  packagesOf,
} from "../lib/git.ts";
import { branchName, slugify } from "../lib/naming.ts";
import { worktreePath } from "../lib/paths.ts";
import { arr, bool, enumOf, obj, str } from "../lib/schema.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";
import { assertFinalAction, assertUpstreamReady } from "../lib/workflow.ts";
import { assertVerifiedRevision } from "../lib/verification.ts";
import { readReceipt, receiptPath, writeReceipt } from "../lib/receipts.ts";

/**
 * Un fichier de test se reconnait a son chemin ou a son extension. Le
 * `developer` n'en ecrit jamais, et cette regle merite mieux qu'une phrase dans
 * un prompt : elle est verifiee ici, au moment du commit, ou elle est
 * verifiable.
 */
const TEST_FILE =
  /(^|\/)(?:tests?|__tests__|spec|e2e|cypress)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.stories\.[cm]?[jt]sx?$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/**
 * L'identite qui signe les commits du worktree. `git.committer` d'autopilot.yaml
 * quand il est renseigne, sinon rien — et c'est alors la configuration git de la
 * machine qui s'applique, comme pour un commit ecrit a la main.
 */
function committerArgs(): string[] {
  const committer = loadConfig().git?.committer;
  if (!committer?.name || !committer?.email) return [];
  return ["-c", `user.name=${committer.name}`, "-c", `user.email=${committer.email}`];
}

export const gitTools: AnyTool[] = [
  defineTool({
    name: "create-worktree",
    description:
      "Cree le worktree git du ticket pour un repo, sur une branche neuve issue de la branche de base du registre. Rend le chemin du worktree. Idempotent : un worktree deja present est reutilise, pas recree.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        repo: str("Nom du repo dans le registre."),
        branch: str("Nom de branche. Omis, il est genere depuis la convention."),
        type: str("Type de branche quand elle est generee : feature, bugfix, ..."),
        title: str("Titre du ticket, pour le slug de la branche generee."),
      },
      ["ticketId", "repo"],
    ),
    handler: async (input: { ticketId: string; repo: string; branch?: string; type?: string; title?: string }) => {
      const repo = findRepo(input.repo);
      const source = repoRoot(repo);
      if (!existsSync(source)) {
        fail(`Repo absent du disque : ${source}.`, `Clone ${repo.gitlabProject} a cet emplacement, ou corrige le registre.`);
      }

      const branch =
        input.branch ??
        branchName({ type: input.type ?? "task", ticket: input.ticketId, titre: input.title ?? input.ticketId });
      const path = worktreePath(input.ticketId, repo.name);

      if (existsSync(path)) {
        return { worktree: path, branch: await currentBranchOf(path), repo: repo.name, created: false };
      }

      mkdirSync(dirname(path), { recursive: true });
      await git(source, ["fetch", "origin", repo.baseBranch, "--quiet"]).catch(() => "");

      const base = (await gitAllowFailure(source, ["rev-parse", "--verify", `origin/${repo.baseBranch}`])).ok
        ? `origin/${repo.baseBranch}`
        : repo.baseBranch;

      const existing = await gitAllowFailure(source, ["rev-parse", "--verify", branch]);
      await git(source, existing.ok ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base]);

      return { worktree: path, branch, base, repo: repo.name, created: true };
    },
  }),

  defineTool({
    name: "setup-repo",
    description:
      "Installe les dependances d'un worktree selon le packageManager du registre. A appeler une fois par repo, avant le premier test : sans lui, le red-checker prendra une erreur d'import pour un echec de test.",
    inputSchema: obj({ ticketId: str("Cle Jira."), repo: str("Nom du repo.") }, ["ticketId", "repo"]),
    handler: async ({ ticketId, repo: name }: { ticketId: string; repo: string }) => {
      const repo = findRepo(name);
      const cwd = worktreePath(ticketId, repo.name);
      if (!existsSync(cwd)) fail(`Worktree absent : ${cwd}.`, "Appelle create-worktree d'abord.");

      // La config locale AVANT l'installation : un `postinstall` peut la lire.
      const carried = carryLocalFiles(repo, cwd);

      const command = installCommand(repo);
      const result = await run(command, { cwd, timeoutMs: loadConfig().timeouts.repoSetupSeconds * 1000 });
      if (result.exitCode !== 0) {
        fail(
          `Installation des dependances en echec dans ${repo.name} (code ${result.exitCode}).`,
          (result.stderr || result.stdout).slice(-1500),
        );
      }
      return {
        repo: repo.name,
        command,
        durationMs: result.durationMs,
        ready: true,
        localFiles: carried,
      };
    },
  }),

  defineTool({
    name: "remove-worktree",
    description:
      "Supprime le worktree d'un repo apres finalisation. A n'appeler qu'une fois la MR creee : tant que le run n'est pas publie, le worktree porte le seul exemplaire du travail.",
    inputSchema: obj(
      { ticketId: str("Cle Jira."), repo: str("Nom du repo."), force: bool("Supprimer meme si le worktree est sale.") },
      ["ticketId", "repo"],
    ),
    handler: async ({ ticketId, repo: name, force }: { ticketId: string; repo: string; force?: boolean }) => {
      const repo = findRepo(name);
      const path = worktreePath(ticketId, repo.name);
      if (!existsSync(path)) return { removed: false, reason: "Worktree deja absent." };
      if (!readReceipt(receiptPath(ticketId, repo.name, "mr.json"))) fail("Un worktree ne se retire qu'apres creation de sa MR.");

      const dirty = (await git(path, ["status", "--porcelain"])) !== "";
      if (dirty) {
        fail(`Worktree sale : ${path}.`, "Sauve ses modifications avant le nettoyage. Le tool ne detruit pas du travail non commite.");
      }
      const source = repoRoot(repo);
      await gitAllowFailure(source, ["worktree", "remove", path, ...(force ? ["--force"] : [])]);
      if (existsSync(path)) rmSync(path, { recursive: true, force: true });
      await gitAllowFailure(source, ["worktree", "prune"]);
      return { removed: true, path };
    },
  }),

  defineTool({
    name: "generate-branch-name",
    description:
      "Construit un nom de branche selon la convention d'autopilot.yaml. Le type choisi ici reste le meme pour la branche et pour la MR du repo.",
    inputSchema: obj(
      {
        // Les types vivent dans autopilot.yaml et sont valides a l'appel : les
        // figer ici obligerait a charger la configuration au chargement du
        // module, et un fichier absent casserait le serveur entier.
        type: str("Type de branche, parmi naming.types d'autopilot.yaml : feature, bugfix, hotfix, documentation, chore, refactor, test, style, task."),
        ticketId: str("Cle Jira."),
        title: str("Titre du ticket, transforme en slug."),
      },
      ["type", "ticketId", "title"],
    ),
    handler: ({ type, ticketId, title }: { type: string; ticketId: string; title: string }) => ({
      branch: branchName({ type, ticket: ticketId, titre: title }),
      slug: slugify(title),
      type,
    }),
  }),

  defineTool({
    name: "generate-commit-message",
    description:
      "Formate un message de commit en conventional commits, et refuse ce qui ne tient pas la convention. Le sujet est en anglais, a l'imperatif, sans point final.",
    inputSchema: obj(
      {
        type: enumOf("Type conventional commit.", [
          "feat",
          "fix",
          "refactor",
          "test",
          "docs",
          "chore",
          "style",
          "perf",
          "build",
          "ci",
        ]),
        subject: str("Sujet en anglais, imperatif, sans majuscule initiale ni point final."),
        scope: str("Portee, souvent le paquet ou le module touche."),
        body: str("Corps facultatif : le pourquoi, pas le quoi."),
        ticketId: str("Cle Jira, ajoutee en pied de message."),
      },
      ["type", "subject"],
    ),
    handler: (input: { type: string; subject: string; scope?: string; body?: string; ticketId?: string }) => {
      const subject = input.subject.trim().replace(/\.$/, "");
      if (!subject) fail("Sujet de commit vide.");
      const header = `${input.type}${input.scope ? `(${input.scope})` : ""}: ${subject}`;
      if (header.length > 72) {
        fail(`En-tete de commit trop long : ${header.length} caracteres, la limite est 72.`, header);
      }
      const parts = [header];
      if (input.body?.trim()) parts.push("", input.body.trim());
      if (input.ticketId) parts.push("", `Refs: ${input.ticketId}`);
      return { message: parts.join("\n"), header };
    },
  }),

  ...(["developer", "test-writer"] as const).map((role) => defineTool({
    name: role === "developer" ? "create-code-commit" : "create-test-commit",
    description:
      `Commit atomique dans le worktree, reserve au ${role}. La zone est fixee par le tool et ne peut pas etre changee dans ses arguments. A appeler apres chaque modification.`,
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        repo: str("Nom du repo."),
        message: str("Message complet, tel que rendu par generate-commit-message."),
        paths: arr("Fichiers a inclure. Omis, tout ce qui est modifie est commite.", str("Chemin relatif au worktree.")),
      },
      ["ticketId", "repo", "message"],
    ),
    handler: async (input: {
      ticketId: string;
      repo: string;
      message: string;
      paths?: string[];
    }) => {
      const repo = findRepo(input.repo);
      const cwd = worktreePath(input.ticketId, repo.name);
      if (!existsSync(cwd)) fail(`Worktree absent : ${cwd}.`);

      await git(cwd, input.paths?.length ? ["add", "--", ...input.paths] : ["add", "-A"]);
      const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
      if (staged.length === 0) return { committed: false, reason: "Rien a commiter." };

      const violations = checkZone(role, staged);
      if (violations.length > 0) {
        await gitAllowFailure(cwd, ["reset"]);
        fail(
          `Le role ${role} n'ecrit pas dans cette zone : ${violations.join(", ")}.`,
          role === "developer"
            ? "Le developer ne touche jamais un test. Remonte une zone non couverte ou un test conteste a l'orchestrateur."
            : "Le test-writer n'ecrit que des fichiers de test.",
        );
      }

      // Le decompte se lit avant le commit, pendant que l'index le porte encore.
      // C'est ce que le live shell affiche du chantier : quels fichiers ont
      // bouge et de combien, sans jamais recopier le diff lui-meme — ca, ca se
      // lit dans la merge request.
      const files = (await git(cwd, ["diff", "--cached", "--numstat"]))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [added, removed, ...rest] = line.split("\t");
          const path = rest.join("\t");
          // `-` sur les deux colonnes : fichier binaire, il n'a pas de lignes.
          return {
            path,
            added: added === "-" ? null : Number(added),
            removed: removed === "-" ? null : Number(removed),
          };
        })
        .filter((entry) => entry.path !== "");

      await git(cwd, [...committerArgs(), "commit", "-m", input.message]);
      const sha = await headSha(cwd);
      return { committed: true, commitSha: sha, files, repo: repo.name };
    },
  })),

  defineTool({
    name: "push-branch",
    description:
      "Pousse la branche du worktree sur le remote. Reserve au finalizer : avant le point 13, la seule ecriture distante autorisee est le tag de publication amont.",
    inputSchema: obj({ ticketId: str("Cle Jira."), repo: str("Nom du repo.") }, ["ticketId", "repo"]),
    handler: async ({ ticketId, repo: name }: { ticketId: string; repo: string }) => {
      const repo = findRepo(name);
      const cwd = worktreePath(ticketId, repo.name);
      if (!existsSync(cwd)) fail(`Worktree absent : ${cwd}.`);
      await assertFinalAction(ticketId, repo.name);
      const sha = await assertVerifiedRevision(ticketId, repo);
      const branch = await currentBranchOf(cwd);
      if (branch === repo.baseBranch || branch === "HEAD") fail("La branche de base ne se publie pas comme une branche de ticket.");
      await git(cwd, ["push", "origin", `${sha}:refs/heads/${branch}`], 300_000);
      writeReceipt(receiptPath(ticketId, repo.name, "branch.json"), { branch, sha });
      return { pushed: true, branch, repo: repo.name, sha };
    },
  }),

  defineTool({
    name: "push-tag",
    description:
      "Pousse UNIQUEMENT un tag, sans aucune ref de branche. C'est la seule ecriture distante autorisee avant le finalizer : un tag se pousse sans pousser de branche, donc sans creer de MR.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        repo: str("Nom du repo."),
        tag: str("Nom du tag, version de dev suffixee par le ticket et le numero de publication."),
        message: str("Message annote du tag."),
      },
      ["ticketId", "repo", "tag"],
    ),
    handler: async (input: { ticketId: string; repo: string; tag: string; message?: string }) => {
      const repo = findRepo(input.repo);
      const cwd = worktreePath(input.ticketId, repo.name);
      if (!existsSync(cwd)) fail(`Worktree absent : ${cwd}.`);

      assertUpstreamReady(input.ticketId, repo.name);
      const sha = await assertVerifiedRevision(input.ticketId, repo);
      await git(cwd, ["check-ref-format", `refs/tags/${input.tag}`]);

      const existing = await listTags(cwd);
      if (existing.includes(input.tag)) {
        const tagged = await git(cwd, ["rev-parse", `refs/tags/${input.tag}^{commit}`]);
        if (tagged !== sha) fail(`Le tag ${input.tag} existe deja sur un autre commit.`, "Incremente le suffixe, ne deplace jamais une version publiee.");
      } else {
        await git(cwd, ["tag", "-a", input.tag, sha, "-m", input.message ?? `${input.tag} (${input.ticketId})`]);
      }
      // `refs/tags/<tag>` et rien d'autre : aucune branche ne part avec.
      await git(cwd, ["push", "origin", `refs/tags/${input.tag}`], 300_000);
      writeReceipt(receiptPath(input.ticketId, repo.name, "upstream.json"), { tag: input.tag, sha });
      return { pushed: true, tag: input.tag, sha, repo: repo.name, resumed: existing.includes(input.tag) };
    },
  }),

  defineTool({
    name: "get-repo-diff",
    description: "Lit le diff du worktree contre sa base et les changements non commites, sans shell agent ni pilote de diff externe. Les fichiers permettent de poursuivre la lecture si un grand diff est tronque.",
    inputSchema: obj({ ticketId: str("Cle Jira."), repo: str("Depot du registre."), paths: arr("Restreindre le diff a ces chemins relatifs.", str("Chemin relatif.")) }, ["ticketId", "repo"]),
    handler: async ({ ticketId, repo: name, paths }: { ticketId: string; repo: string; paths?: string[] }) => {
      const repo = findRepo(name);
      const cwd = worktreePath(ticketId, repo.name);
      const remote = (await gitAllowFailure(cwd, ["rev-parse", "--verify", `origin/${repo.baseBranch}`])).ok;
      const base = remote ? `origin/${repo.baseBranch}` : repo.baseBranch;
      return {
        files: await changedFiles(cwd, base),
        committed: await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", `${base}...HEAD`, "--", ...(paths ?? [])]),
        uncommitted: await git(cwd, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", ...(paths ?? [])]),
      };
    },
  }),

  defineTool({
    name: "monorepo-filter",
    description:
      "Deduit les paquets touches a partir des fichiers modifies, en remontant au package.json le plus proche, et rend les drapeaux de filtre du monorepoTool. Sert a cadrer les verifications et le perimetre d'impact d'une review.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        repo: str("Nom du repo."),
        files: arr("Fichiers a analyser. Omis, le diff avec la branche de base est utilise.", str("Chemin relatif.")),
      },
      ["ticketId", "repo"],
    ),
    handler: async (input: { ticketId: string; repo: string; files?: string[] }) => {
      const repo = findRepo(input.repo);
      const cwd = worktreePath(input.ticketId, repo.name);
      const files = input.files ?? (existsSync(cwd) ? await changedFiles(cwd, repo.baseBranch) : []);
      const packages = repo.monorepoTool ? packagesOf(cwd, files) : [];
      return {
        repo: repo.name,
        monorepoTool: repo.monorepoTool,
        files,
        packages,
        filter: filterFlags(repo, packages),
        note: repo.monorepoTool
          ? "Ajoute `filter` aux commandes du registre pour ne verifier que ce qui a bouge."
          : "Ce repo n'est pas un monorepo : les commandes du registre s'appliquent telles quelles.",
      };
    },
  }),
];

function checkZone(role: string, files: readonly string[]): string[] {
  if (role === "developer") return files.filter(isTestFile);
  if (role === "test-writer") return files.filter((file) => !isTestFile(file));
  return [];
}

async function currentBranchOf(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/**
 * Porter la configuration locale de la source vers le worktree.
 *
 * `.env` est gitignore, donc `git worktree add` ne l'emmene pas. Le worktree
 * demarre sans les secrets, le serveur ne boote pas, et l'echec remonte
 * deguise en test rouge — ou en escalade dont personne ne devine la cause.
 *
 * Trois garde-fous : on ne copie que ce que le registre declare, jamais
 * par-dessus un fichier deja present dans le worktree, et jamais hors du depot
 * (un `../` dans le registre serait une exfiltration de fichier, pas une
 * configuration).
 */
export function carryLocalFiles(repo: RepoEntry, cwd: string): { copied: string[]; missing: string[] } {
  const declared = repo.localFiles ?? [];
  const copied: string[] = [];
  const missing: string[] = [];
  const source = resolve(expandTilde(repo.path));

  for (const entry of declared) {
    const from = resolve(source, entry);
    const to = resolve(cwd, entry);
    if (!from.startsWith(`${source}/`) || !to.startsWith(`${resolve(cwd)}/`)) {
      fail(`\`localFiles\` sort du depot : ${entry}.`, "Un chemin de configuration reste sous la racine du depot.");
    }
    if (existsSync(to)) continue;
    if (!existsSync(from)) {
      missing.push(entry);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(entry);
  }
  return { copied, missing };
}
