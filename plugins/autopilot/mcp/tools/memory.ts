import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail } from "../lib/errors.ts";
import { git, gitAllowFailure } from "../lib/git.ts";
import {
  type Frontmatter,
  SCOPES,
  SCOPE_DIRECTORIES,
  type Scope,
  assertNoteLength,
  deleteNote,
  ensureMemoryLayout,
  listNotes,
  notePath,
  parseNote,
  queryNotes,
  writeNote,
} from "../lib/memory.ts";
import { autopilotHome, memoryDir, ticketKey, ticketStatePath } from "../lib/paths.ts";
import { arr, bool, enumOf, num, obj, str } from "../lib/schema.ts";
import { patchTicketState } from "../lib/store.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";

export const memoryTools: AnyTool[] = [
  defineTool({
    name: "get-memory",
    description:
      "Cherche dans la base de connaissances : filtre deterministe sur le frontmatter (scope, feature, repos, type) plus grep sur le contenu. A appeler AVANT d'explorer le code. Rend les chemins des notes pour qu'un autre agent puisse y retourner.",
    inputSchema: obj({
      scope: arr("Niveaux a fouiller. Omis, tous.", enumOf("Niveau", SCOPES)),
      feature: str("Valeur exacte du champ `feature` du frontmatter."),
      repos: arr("Ne garder que les notes qui declarent au moins un de ces repos.", str("Nom de repo du registre.")),
      type: str("Valeur exacte du champ `type` du frontmatter."),
      pathPrefix: str("Prefixe de chemin, par exemple `repos/web-app/`."),
      grep: str("Expression reguliere, insensible a la casse, appliquee au corps et au chemin."),
      limit: num("Nombre maximum de notes rendues."),
      full: bool("Rendre le corps complet des notes. Faux par defaut : seuls le chemin et le frontmatter sortent."),
    }),
    handler: (input: {
      scope?: Scope[];
      feature?: string;
      repos?: string[];
      type?: string;
      pathPrefix?: string;
      grep?: string;
      limit?: number;
      full?: boolean;
    }) => {
      const notes = queryNotes(input);
      return {
        total: notes.length,
        notes: notes.map((note) => ({
          path: note.path,
          frontmatter: note.frontmatter,
          lines: note.lines,
          body: input.full ? note.body : undefined,
          excerpt: input.full ? undefined : firstLines(note.body, 3),
        })),
        note:
          notes.length === 0
            ? "Aucune note ne correspond. Cite ce vide dans ta synthese : une memoire muette n'est pas une memoire d'accord."
            : "Cite les chemins dans ta synthese, un autre agent doit pouvoir y retourner.",
      };
    },
  }),

  defineTool({
    name: "create-memory",
    description:
      "Cree une note de memoire. Reserve au memory-writer, qui applique le plan du memory-planner. Le chemin doit correspondre au scope declare, et le corps ne depasse jamais la limite de lignes configuree.",
    inputSchema: obj(
      {
        path: str("Chemin relatif a memory/, par exemple `repos/web-app/conventions-tests.md`."),
        frontmatter: obj(
          {
            type: str("Nature de la note, par exemple `knowledge`, `convention`, `piege`."),
            scope: enumOf("Niveau le plus haut ou la connaissance reste vraie.", SCOPES),
            feature: str("Feature concernee, quand il y en a une."),
            last_verified: str("Date de derniere verification, AAAA-MM-JJ."),
            repos: arr("Repos concernes.", str("Nom de repo.")),
            source: obj(
              { ticket: str("Cle du ticket d'origine."), figma: str("URL de la maquette d'origine.") },
              [],
              { description: "D'ou vient la connaissance. Sans provenance, on ne sait pas quoi reverifier quand elle est contredite." },
            ),
          },
          ["type", "scope", "last_verified"],
          { description: "Le frontmatter complet de la note, tel que le memory-planner l'a decide." },
        ),
        body: str("Corps de la note, en markdown."),
      },
      ["path", "frontmatter", "body"],
    ),
    handler: (input: { path: string; frontmatter: Frontmatter; body: string }) => {
      ensureMemoryLayout();
      if (existsSync(notePath(input.path))) {
        fail(`La note ${input.path} existe deja.`, "Utilise write-memory pour la mettre a jour.");
      }
      writeNote(input.path, input.frontmatter, input.body);
      return { created: input.path };
    },
  }),

  defineTool({
    name: "write-memory",
    description:
      "Met a jour une note existante. Reserve au memory-writer. Rend la note telle qu'elle est apres ecriture, pour que le plan puisse etre verifie ligne par ligne.",
    inputSchema: obj(
      {
        path: str("Chemin relatif a memory/."),
        frontmatter: obj(
          {
            type: str("Nature de la note."),
            scope: enumOf("Niveau.", SCOPES),
            feature: str("Feature concernee."),
            last_verified: str("Date de derniere verification, AAAA-MM-JJ."),
            repos: arr("Repos concernes.", str("Nom de repo.")),
            source: obj(
              { ticket: str("Cle du ticket."), figma: str("URL de la maquette.") },
              [],
              { description: "D'ou vient la connaissance." },
            ),
          },
          ["type", "scope", "last_verified"],
          { description: "Le frontmatter complet apres mise a jour. Il remplace l'ancien." },
        ),
        body: str("Nouveau corps complet de la note."),
      },
      ["path", "frontmatter", "body"],
    ),
    handler: (input: { path: string; frontmatter: Frontmatter; body: string }) => {
      if (!existsSync(notePath(input.path))) {
        fail(`Note inexistante : ${input.path}.`, "Utilise create-memory pour la creer.");
      }
      assertNoteLength(input.path, input.body);
      writeNote(input.path, input.frontmatter, input.body);
      return { updated: input.path, lines: parseNote(input.path, readFileSync(notePath(input.path), "utf8")).lines };
    },
  }),

  defineTool({
    name: "delete-memory",
    description:
      "Supprime une note. C'est l'outil de la consolidation : sans suppression, apres trente tickets trois notes disent la meme chose differemment et les agents partent une fois sur deux sur la version perimee.",
    inputSchema: obj(
      { path: str("Chemin relatif a memory/."), reason: str("Pourquoi elle disparait : fusionnee, perimee, fausse.") },
      ["path", "reason"],
    ),
    handler: ({ path, reason }: { path: string; reason: string }) => {
      deleteNote(path);
      return { deleted: path, reason };
    },
  }),

  defineTool({
    name: "contradict-memory",
    description:
      "Signale qu'une note ne correspond pas au code reel, avec la preuve. Empile la contradiction dans l'etat du ticket ; le memory-planner la traite EN PREMIER au point 11. C'est le mecanisme qui empeche la base de pourrir : utilise-le des que tu lis une note fausse, ne la contourne pas en silence.",
    inputSchema: obj(
      {
        ticketId: str("Cle du ticket en cours."),
        note: str("Chemin de la note mise en cause, relatif a memory/."),
        claim: str("Ce que la note affirme, en une phrase."),
        evidence: str("La preuve du contraire, sous la forme fichier:ligne — pas une impression."),
        raisedBy: str("Nom de l'agent qui signale."),
      },
      ["ticketId", "note", "claim", "evidence", "raisedBy"],
    ),
    handler: (input: { ticketId: string; note: string; claim: string; evidence: string; raisedBy: string }) => {
      if (!/\S+:\d+/.test(input.evidence)) {
        fail(
          "Une contradiction demande une preuve localisee.",
          "Donne un fichier et une ligne, par exemple `package.json:31 — rstest`.",
        );
      }
      patchTicketState(input.ticketId, {
        memory: {
          contradictions: [
            {
              note: input.note,
              claim: input.claim,
              evidence: input.evidence,
              raisedBy: input.raisedBy,
              at: new Date().toISOString(),
            },
          ],
        },
      });
      return { stacked: true, note: input.note, treatedAt: "point 11, par le memory-planner" };
    },
  }),

  defineTool({
    name: "commit-memory",
    description:
      "Commite le diff memoire du run sous `memory: <ticket-id>`. Seul point d'entree du versionnement memoire. Le commit unique est ce qui rend la validation a posteriori possible : on le relit, on le revert s'il est faux.",
    inputSchema: obj(
      {
        ticketId: str("Cle du ticket, elle donne le message de commit."),
        summary: str("Resume du plan applique, place dans le corps du commit."),
      },
      ["ticketId"],
    ),
    handler: async ({ ticketId, summary }: { ticketId: string; summary?: string }) => {
      const home = autopilotHome();
      await ensureAutopilotRepo(home);

      const ticketFile = `tickets/${ticketKey(ticketId)}.yaml`;
      const before = await git(home, ["diff", "--cached", "--name-only"]);
      if (before.split("\n").some((file) => file && !file.startsWith("memory/") && file !== ticketFile)) {
        fail("L'index memoire porte des fichiers d'un autre run.", "Termine ce commit avant de capitaliser ce ticket.");
      }
      await git(home, ["add", "--", "memory", ...(existsSync(ticketStatePath(ticketId)) ? [ticketFile] : [])]);
      const staged = await gitAllowFailure(home, ["diff", "--cached", "--name-only"]);
      if (!staged.output.trim()) {
        return { committed: false, reason: "Aucun changement memoire a commiter." };
      }

      const message = summary ? `memory: ${ticketId}\n\n${summary}` : `memory: ${ticketId}`;
      await git(home, ["-c", "user.name=autopilot", "-c", "user.email=autopilot@localhost", "commit", "-m", message]);
      const sha = await git(home, ["rev-parse", "--short", "HEAD"]);

      // Le sha ne peut pas figurer dans le commit qui le produit : cette
      // derniere ecriture d'etat part donc dans le commit du run suivant. C'est
      // un decalage d'un run sur ce seul champ, et il est prefere a un second
      // commit qui ferait perdre l'unicite — c'est elle qui rend le revert sur.
      patchTicketState(ticketId, { memory: { commit: sha } });
      return {
        committed: true,
        sha,
        files: staged.output.split("\n").filter(Boolean),
        revert: `git -C ${home} revert ${sha}`,
      };
    },
  }),
];

/**
 * `~/.autopilot` est un depot git, mais tout y est gitignore sauf `memory/` et
 * `tickets/`. Est versionne ce qui a de la valeur apres le run : la
 * connaissance accumulee et l'histoire d'un ticket. Pas un lock, pas un flux
 * d'events, et surtout pas des worktrees avec leurs node_modules.
 */
export async function ensureAutopilotRepo(home = autopilotHome()): Promise<void> {
  mkdirSync(join(home, "tickets"), { recursive: true });
  ensureMemoryLayout(memoryDir());

  const gitignore = join(home, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(
      gitignore,
      [
        "# Tout est ignore, sauf ce qui a de la valeur apres le run.",
        "*",
        "!.gitignore",
        "!memory/",
        "!memory/**",
        "!tickets/",
        "!tickets/**",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (!existsSync(join(home, ".git"))) {
    await git(home, ["init", "-q", "-b", "main"]);
  }
}

function firstLines(body: string, count: number): string {
  return body
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, count)
    .join("\n");
}

export { SCOPE_DIRECTORIES, listNotes };
