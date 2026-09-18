import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { loadConfig } from "../lib/config.ts";
import {
  type LiveEvent,
  appendEvent,
  broadcast,
  liveSessionPath,
  nextSeq,
  readLiveSession,
  validateEvent,
  writeLiveSession,
} from "../lib/events.ts";
import { fail } from "../lib/errors.ts";
import { agentsDir, liveShellDir } from "../lib/paths.ts";
import { anyValue, arr, enumOf, num, obj, str } from "../lib/schema.ts";
import { patchTicketState, readTicketState } from "../lib/store.ts";
import { type AnyTool, type ToolContext, defineTool } from "../lib/tool.ts";
import { LIVE_EVENT_KINDS, LIVE_EVENT_STATUSES } from "../lib/events.ts";
import { assertPlanReady, fingerprint, planFingerprint, recordPlanApproval } from "../lib/workflow.ts";

/** Les causes d'escalade. Ce qui n'est pas dans cette liste vaut `convergence`. */
const CAUSES = ["convergence", "environment", "arbitrage"];

export const humanTools: AnyTool[] = [
  defineTool({
    name: "ask-user",
    description:
      "Pose un LOT de questions a l'humain et BLOQUE jusqu'aux reponses. C'est volontaire : le workflow ne doit pas avancer pendant qu'il attend un arbitrage. Groupe tout ce que tu peux demander au meme moment — trois questions posees separement, c'est trois arrets la ou un seul suffit. Chaque question porte trois ou quatre options ; un champ libre est toujours offert en plus, tu n'as pas a le prevoir. Deux transports, une seule interface : le live shell quand il tourne, le terminal sinon. N'essaie jamais de choisir le transport toi-meme.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira, elle rattache les questions au run."),
        questions: arr(
          "Les questions a poser en une fois. Regroupe tout ce qui peut etre tranche au meme moment.",
          obj(
            {
              key: str("Identifiant court et stable, c'est lui qui rapporte la reponse. Par exemple `periode-defaut`."),
              header: str("Deux ou trois mots, affiches en etiquette. Par exemple `Periode par defaut`."),
              question: str("La question, complete et lisible seule. Donne le contexte, ne renvoie pas a un message precedent."),
              options: arr(
                "Trois ou quatre reponses plausibles, formulees pour etre choisies telles quelles. Un champ libre s'ajoute tout seul.",
                str("Une option."),
              ),
            },
            ["key", "header", "question"],
            { description: "Une question du lot." },
          ),
        ),
        askedBy: str("Nom de l'agent qui pose les questions."),
      },
      ["ticketId", "questions"],
    ),
    handler: async (
      input: {
        ticketId: string;
        questions: { key: string; header: string; question: string; options?: string[] }[];
        askedBy?: string;
      },
      context: ToolContext,
    ) => {
      const asked = new Date().toISOString();
      const session = readLiveSession(input.ticketId);

      const questions = input.questions.map((entry, index) => ({
        key: entry.key?.trim() || `q${index + 1}`,
        header: entry.header?.trim() || `Question ${index + 1}`,
        question: entry.question.trim(),
        options: (entry.options ?? []).filter(Boolean),
      }));

      if (questions.length === 0) fail("`questions` est vide.", "Pose au moins une question.");

      // Le gate du point 9 n'est pas un lot de questions.
      //
      // Il a sa propre vue — le plan entier, ses depots dans l'ordre, ses deux
      // checklists — et ses trois sorties. Pose-le en question et l'humain voit
      // « Une question arrete le run » au-dessus d'un champ vide, sans le plan
      // qu'il est cense approuver. On refuse ici, ou l'erreur est encore
      // corrigeable, plutot que de laisser passer un gate aveugle.
      if (stepIndex(currentStep(input.ticketId)) === 9) {
        fail(
          "Le point 9 ne se pose pas avec `ask-user`.",
          "Utilise `ask-plan-approval` avec `plan.repos` : il affiche le plan entier et rend `approve`, `amend` ou `reject`.",
        );
      }
      const thin = questions.filter((entry) => entry.options.length > 0 && entry.options.length < 2);
      if (thin.length > 0) {
        fail(
          `Une seule option proposee sur : ${thin.map((entry) => entry.key).join(", ")}.`,
          "Une option unique n'est pas un choix. Donnes-en trois ou quatre, ou aucune.",
        );
      }

      await record(input.ticketId, {
        kind: "question",
        status: "waiting",
        agent: input.askedBy ?? null,
        title:
          questions.length === 1
            ? truncate(questions[0]?.question ?? "", 180)
            : `${questions.length} questions : ${questions.map((entry) => entry.header).join(", ")}`,
        detail: questions
          .map((entry) => `${entry.header} — ${entry.question}${entry.options.length ? `\n  Options : ${entry.options.join(" | ")}` : ""}`)
          .join("\n\n"),
        payload: { questions },
      });

      // Transport 1 : le live shell, quand il tourne VRAIMENT.
      //
      // Le fichier de session survit au shell. Un shell ferme, tue, ou relance
      // sur un autre port laisse derriere lui un fichier qui dit « je suis la »,
      // et on partait poser les questions dans le vide avant de se replier en
      // silence. On demande donc a l'app, pas au fichier.
      const batchId = `q-${input.ticketId}-${Date.now().toString(36)}`;
      if (session && (await isAlive(session.url, input.ticketId))) {
        const answers = await askLiveShell(
          session.url,
          { id: batchId, questions, askedBy: input.askedBy ?? null },
          context.heartbeat,
        );
        if (answers) {
          await finishQuestion(input.ticketId, input.askedBy ?? null, answers, "live");
          return { answers, transport: "live", askedAt: asked };
        }
        // Rien n'est arrive a temps : on retire le lot avant de le reposer au
        // terminal. Sans ce retrait, la page garde un formulaire qui ne
        // debloque plus rien — et repondre dedans ne fait rien du tout.
        await withdrawFromLiveShell(session.url, batchId);
      }

      // Transport 2 : le terminal, par elicitation. C'est aussi le repli quand
      // le live shell ne repond plus. Un champ par question, en une seule
      // invite : le lot reste un lot.
      if (context.canAskHuman) {
        const fields: Record<string, { title: string; description?: string }> = {};
        for (const entry of questions) {
          fields[entry.key] = {
            title: entry.header,
            description: entry.options.length > 0 ? entry.options.join(" | ") : undefined,
          };
        }
        const result = await context.askHuman(formatQuestions(questions), fields);
        if (result.action === "accept" && result.content) {
          const answers: Record<string, string> = {};
          for (const entry of questions) answers[entry.key] = String(result.content[entry.key] ?? "").trim();
          const missing = questions.filter((entry) => !answers[entry.key]).map((entry) => entry.key);
          if (missing.length === 0) {
            await finishQuestion(input.ticketId, input.askedBy ?? null, answers, "terminal");
            return { answers, transport: "terminal", askedAt: asked };
          }
          return {
            answers,
            transport: "terminal",
            incomplete: missing,
            note: `Sans reponse sur ${missing.join(", ")}, n'avance pas sur une hypothese : repose la question ou escalade.`,
          };
        }
        return {
          answers: null,
          transport: "terminal",
          declined: true,
          note: "L'humain n'a pas repondu. N'avance pas sur une hypothese : reformule, ou escalade.",
        };
      }

      // Transport 3 : aucun canal direct. On rend les questions a l'agent
      // appelant, qui les posera dans le fil. L'interface reste la meme.
      return {
        answers: null,
        transport: "caller",
        questions,
        note: "Aucun canal direct disponible. Pose ces questions telles quelles a l'humain, en proposant les options, puis poursuis une fois les reponses obtenues.",
      };
    },
  }),

  defineTool({
    name: "ask-plan-approval",
    description:
      "Soumet le plan au gate humain du point 9 et BLOQUE jusqu'au verdict. Remplace `ask-user` pour ce moment precis : un plan se lit sur une page, pas dans un formulaire de cinq questions. Trois sorties — `approve`, `amend`, `reject` — et les deux dernieres rendent une note qui dit quoi changer ou pourquoi. Ne soumets ni le perimetre ni les checklists : ils ont leurs propres vues et se lisent a cote.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        repos: arr(
          "Les depots du plan, dans l'ordre d'execution — level croissant, amont vers aval. C'est cet ordre-la qui est approuve avec le reste.",
          obj(
            {
              repo: str("Nom du depot, celui du registre."),
              level: num("Son level, tel qu'il est dans le scope."),
              changes: arr("Ce qui change, une ligne par chose.", str("Une chose qui change.")),
              why: str("Pourquoi ce depot passe a ce moment-la."),
            },
            ["repo"],
            { description: "Le plan d'un depot." },
          ),
        ),
        note: str("Ce que tu veux dire en plus du plan lui-meme. Facultatif."),
        askedBy: str("Nom de l'agent qui soumet, exactement celui de sa definition."),
      },
      ["ticketId", "repos"],
    ),
    handler: async (
      input: {
        ticketId: string;
        repos: { repo: string; level?: number; changes?: string[]; why?: string }[];
        note?: string;
        askedBy?: string;
      },
      context: ToolContext,
    ) => {
      const repos = input.repos
        .filter((entry) => entry?.repo?.trim())
        .map((entry) => ({
          repo: entry.repo.trim(),
          level: typeof entry.level === "number" ? entry.level : null,
          changes: (entry.changes ?? []).map((change) => String(change).trim()).filter(Boolean),
          why: entry.why?.trim() || null,
        }));
      if (repos.length === 0) fail("`repos` est vide.", "Un plan sans depot n'est pas un plan.");

      const state = assertPlanReady(input.ticketId);
      const planned = (state.plan.repos as Record<string, unknown>[]).map((entry) => ({
        repo: entry.repo,
        level: typeof entry.level === "number" ? entry.level : null,
        changes: Array.isArray(entry.changes) ? entry.changes.map(String).map((change) => change.trim()).filter(Boolean) : [],
        why: typeof entry.why === "string" ? entry.why.trim() || null : null,
      }));
      if (fingerprint(planned) !== fingerprint(repos)) fail("Le plan affiche doit etre exactement plan.repos dans l'etat du ticket.");
      const submittedFingerprint = planFingerprint(state);

      const asked = new Date().toISOString();
      const session = readLiveSession(input.ticketId);
      const planId = `p-${input.ticketId}-${Date.now().toString(36)}`;

      await record(input.ticketId, {
        kind: "plan",
        status: "waiting",
        agent: input.askedBy ?? null,
        title: `Plan soumis : ${repos.map((entry) => entry.repo).join(", ")}`,
        detail: repos
          .map((entry) => `${entry.repo}${entry.why ? ` — ${entry.why}` : ""}\n  ${entry.changes.join("\n  ")}`)
          .join("\n\n"),
        payload: { repos, note: input.note?.trim() || null },
      });

      // Transport 1 : le live shell, quand il tourne vraiment. Meme pouls que
      // pour un lot de questions : on attend tant que la page peut repondre.
      if (session && (await isAlive(session.url, input.ticketId))) {
        const decision = await decideInLiveShell(
          session.url,
          { id: planId, repos, note: input.note?.trim() || null, askedBy: input.askedBy ?? null },
          context.heartbeat,
        );
        if (decision) {
          await finishPlan(input.ticketId, input.askedBy ?? null, decision, "live", submittedFingerprint);
          return { ...decision, transport: "live", askedAt: asked };
        }
        await withdrawFromLiveShell(session.url, planId);
      }

      // Transport 2 : le terminal. Le gate doit pouvoir se tenir sans la page —
      // sinon le shell devient un point de defaillance, ce qu'il n'est pas.
      if (context.canAskHuman) {
        const result = await context.askHuman(formatPlan(repos, input.note?.trim() || null), {
          verdict: { title: "Verdict", description: "approve | amend | reject" },
          note: { title: "Ce qui cloche", description: "Obligatoire sauf sur approve." },
        });
        const verdict = String(result.content?.verdict ?? "").trim().toLowerCase();
        if (result.action === "accept" && ["approve", "amend", "reject"].includes(verdict)) {
          const decision = {
            verdict: verdict as "approve" | "amend" | "reject",
            note: String(result.content?.note ?? "").trim(),
          };
          if (decision.verdict !== "approve" && !decision.note) {
            return {
              verdict: null,
              transport: "terminal",
              note: "Un plan renvoye sans dire ce qui cloche repart sur la meme hypothese. Redemande le verdict avec sa raison.",
            };
          }
          await finishPlan(input.ticketId, input.askedBy ?? null, decision, "terminal", submittedFingerprint);
          return { ...decision, transport: "terminal", askedAt: asked };
        }
        return {
          verdict: null,
          transport: "terminal",
          declined: true,
          note: "Pas de verdict. N'avance pas : le point 9 est le seul gate, et rien ne passe sans lui.",
        };
      }

      // Transport 3 : aucun canal direct. Le plan revient a l'appelant, qui le
      // posera dans le fil.
      return {
        verdict: null,
        transport: "caller",
        repos,
        note: "Aucun canal direct disponible. Affiche le plan puis lance le live shell et rappelle ask-plan-approval. Seule une reponse via le shell ou l'elicitation MCP produit la preuve necessaire a la publication.",
      };
    },
  }),

  defineTool({
    name: "escalate-to-human",
    description:
      "Arrete le run et rend la main. Ce n'est pas une question, c'est un arret : budget de boucle epuise, timeout CI, meme test conteste deux fois, harnais de test inutilisable. Jamais d'abandon silencieux, jamais de livraison en l'etat.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        reason: str("Ce qui bloque, en une phrase factuelle."),
        step: str("Point exact du workflow, par exemple 10.6."),
        repo: str("Repo concerne, s'il y en a un."),
        detail: str("Le detail utile pour reprendre a la main : compteurs, derniers retours, sorties de test."),
        cause: str(
          "Ce qui a bloque, au choix : `convergence` (les agents ne se mettent pas d'accord, le budget est epuise), " +
            "`environment` (le harnais, l'infra ou l'outillage empechent de rendre un verdict — la boucle n'a rien juge, elle n'a pas pu), " +
            "`arbitrage` (une decision produit qui n'appartient pas a un agent). Par defaut `convergence`.",
        ),
      },
      ["ticketId", "reason", "step"],
    ),
    handler: async (input: {
      ticketId: string;
      reason: string;
      step: string;
      repo?: string;
      detail?: string;
      cause?: string;
    }) => {
      const at = new Date().toISOString();
      // Toutes les escalades ne disent pas la meme chose. Une escalade de
      // convergence accuse le travail : les tours ont eu lieu, ils n'ont pas
      // suffi. Une escalade d'environnement n'accuse rien du tout — la boucle
      // n'a pas juge, elle n'a pas pu. Les confondre a coute trois heures sur
      // FT-1042, ou un run s'est arrete sur « budgets epuises » alors que le
      // seul obstacle etait une sortie de test coupee au milieu.
      const cause = CAUSES.includes(input.cause ?? "") ? (input.cause as string) : "convergence";
      patchTicketState(input.ticketId, {
        run: {
          phase: "escalated",
          escalation: { at, step: input.step, repo: input.repo ?? null, reason: input.reason, cause },
        },
        metrics: { humanInterventions: { __increment: 1 } },
      });
      await record(input.ticketId, {
        kind: "escalation",
        status: "ko",
        repo: input.repo ?? null,
        title: `Escalade au point ${input.step} : ${truncate(input.reason, 120)}`,
        detail: input.detail ?? null,
        payload: { step: input.step, repo: input.repo ?? null, cause },
      });
      return {
        escalated: true,
        at,
        cause,
        note:
          (String(input.step).startsWith("13")
            ? "La publication peut avoir reussi partiellement. Relis l'etat et les journaux d'operations avant de reprendre ; ne duplique aucun effet distant."
            : "Rien n'est publie au point 13 : les commits et tags amont deja poses restent en place. Relancer /autopilot-start reprendra ici.") +
          (cause === "environment"
            ? " Cause `environment` : les compteurs de boucle ne doivent pas avoir bouge, la reprise repart avec le meme budget."
            : ""),
      };
    },
  }),

  defineTool({
    name: "launch-live-mode",
    description:
      "Demarre le live shell sur un port libre de la plage configuree et l'ouvre dans le navigateur. A appeler AVANT le point 1 quand le run est lance avec --live. Le shell est une fenetre sur le run, jamais un pilote : s'il meurt, le run continue.",
    inputSchema: obj({ ticketId: str("Cle Jira."), runId: str("Identifiant du run.") }, ["ticketId", "runId"]),
    handler: async ({ ticketId, runId }: { ticketId: string; runId: string }) => {
      const existing = readLiveSession(ticketId);
      if (existing && (await isAlive(existing.url, ticketId))) {
        return { launched: false, reused: true, url: existing.url, runId: existing.runId };
      }

      const directory = liveShellDir();
      if (!existsSync(directory)) fail(`Live shell introuvable a ${directory}.`);

      const { portRange, openBrowser } = loadConfig().liveMode;
      const port = await findFreePort(portRange[0], portRange[1]);
      const url = `http://127.0.0.1:${port}`;

      const child = spawn("pnpm", ["run", "start", "--port", String(port), "--strictPort"], {
        cwd: directory,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PORT: String(port), AUTOPILOT_TICKET_ID: ticketId, AUTOPILOT_RUN_ID: runId },
      });
      const spawned = await new Promise<boolean>((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", () => resolve(false));
      });
      if (!spawned || !child.pid || child.pid <= 1) {
        return { launched: false, ready: false, url, note: "pnpm n'a pas pu demarrer le live shell. Verifie son installation et le PATH ; aucune session n'a ete enregistree." };
      }
      child.unref();

      const ready = await waitFor(url, 60_000, ticketId);
      if (!ready) {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, "SIGTERM"); } catch { /* processus deja termine */ }
        }
        return { launched: false, ready: false, url, note: "Le live shell n'a pas repondu ; aucune session morte n'a ete enregistree." };
      }
      writeLiveSession({ runId, ticketId, port, url, pid: child.pid, startedAt: new Date().toISOString() });
      reapWithSession(child.pid, ticketId);
      patchTicketState(ticketId, { run: { liveRunId: runId } });

      if (ready && openBrowser) {
        const browser = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
        browser.on("error", () => { /* Un navigateur absent ne termine pas le run. */ });
        browser.unref();
      }

      return {
        launched: true,
        url,
        port,
        ready,
        note: ready
          ? "Le shell rejoue l'historique d'events avant de se brancher sur le direct."
          : "Le shell n'a pas repondu a temps. Le run continue sans lui : ce n'est pas un point de defaillance.",
      };
    },
  }),

  defineTool({
    name: "push-live-mode-event",
    description:
      "Pousse un event dans le flux du run. A appeler par CHAQUE agent au moment ou il fait quelque chose : prise de main, changement de tool, resultat, fin. Il n'y a pas de cablage central — un agent qui ne pousse pas laisse un trou dans l'interface.\n\nCe que tu ecris dans `title` est lu par quelqu'un qui n'a pas lance ce run et qui ne connait pas le workflow. Il voit deja, autour de ta phrase, le libelle de l'etape, ton nom, ton tool, la duree et l'etat : ta phrase ne sert qu'a dire CE QUE TU FAIS, en francais accentue.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        runId: str("Identifiant du run. Omis, celui de la session live est repris."),
        kind: enumOf("Nature de l'event.", LIVE_EVENT_KINDS),
        status: enumOf("Ou en est l'action.", LIVE_EVENT_STATUSES),
        title: str(
          "Une ligne, l'action en cours ou ce que tu as trouve. Un verbe pour ce qui se fait, le constat d'abord pour un resultat. Vise 90 caracteres ; le long va dans `detail`.\n\nN'y mets RIEN de ce que l'interface affiche deja a cote : pas de numero ni de nom d'etape (« Point 3 », « 10.4 », « Gate », « Q1 / »), pas de ton nom ni de celui du tool, pas de mot d'etat (« en cours », « OK », « termine » — c'est `status` qui le dit), pas la cle du ticket.\n\nNon : « Point 3 — doc-scout : memoire quasi vide sur le sujet ». Oui : « La memoire ne sait presque rien : 3 notes, aucune sur l'A/B testing »."
        ),
        detail: str("Le detail : chiffres, chemins, preuves, raisonnement. Affiche sous le titre, et c'est la que va tout ce qui ne tient pas en une ligne."),
        agent: str(
          "Ton nom, exactement celui du champ `name` de ta definition — `doc-scout`, pas `memory-scout`, pas le titre de ton document. C'est cette chaine qui te rattache a ton etape dans l'interface ; un nom invente t'y fait apparaitre en agent fantome, rattache a rien.",
        ),
        tool: str("Nom du tool en cours."),
        repo: str("Repo courant du cycle 10.x."),
        step: str("N'y touche pas : le tool lit l'etape courante dans l'etat du ticket. A ne forcer que pour rejouer un event hors de son moment."),
        payload: anyValue(
          "Donnee structuree propre au kind. Le live shell n'affiche QUE ce qu'il recoit ici — il ne reconstitue rien.\n\n" +
            "- `loop` : `{ name, count, budget }`\n" +
            "- `todo` : `{ items: [{ text, status }] }`, status parmi `pending` | `in_progress` | `completed`. Pousse la liste ENTIERE a chaque changement, elle remplace la precedente.\n" +
            "- apres un commit : `{ commit: { sha, files } }` ou `files` est le tableau rendu par `create-commit`, chaque entree `{ path, added, removed }`.\n" +
            "- apres une verification : `{ check: { kind, passed, durationMs } }`, repris tel quel du retour de `run-test-*`, `run-lint` ou `run-typecheck`.\n\n" +
            "Renseigne aussi `repo` sur ces events : c'est lui qui rattache le chantier a son depot.",
        ),
      },
      ["ticketId", "kind", "status", "title"],
    ),
    handler: async (input: {
      ticketId: string;
      runId?: string;
      kind: LiveEvent["kind"];
      status: LiveEvent["status"];
      title: string;
      detail?: string;
      agent?: string;
      tool?: string;
      repo?: string;
      step?: string;
      payload?: unknown;
    }) => {
      // Un roster vide veut dire qu'on n'a pas su lire les definitions, pas
      // qu'aucun agent n'existe : on ne refuse alors personne.
      if (input.agent && knownAgents().size > 0 && !knownAgents().has(input.agent)) {
        fail(
          `Aucun agent ne s'appelle \`${input.agent}\`.`,
          `Pousse ton nom exact, celui du champ \`name\` de ta definition : ${[...knownAgents()].sort().join(", ")}.`,
        );
      }

      const delivery = await record(input.ticketId, {
        kind: input.kind,
        status: input.status,
        title: input.title,
        detail: input.detail ?? null,
        agent: input.agent ?? null,
        tool: input.tool ?? null,
        repo: input.repo ?? null,
        step: input.step ?? null,
        payload: input.payload ?? null,
        runId: input.runId,
      });
      return delivery;
    },
  }),
];

// ------------------------------------------------------------- interne ----

/**
 * Les noms d'agents qui existent vraiment.
 *
 * Un agent qui se pousse sous un nom invente — le `doc-scout` qui s'annonce
 * `memory-scout` parce que son titre parle de memoire — n'est rattachable a
 * rien : ni a son etape, ni a sa ligne dans le rail. Ca ne casse rien, ca
 * degrade juste l'interface en silence, ce qui est pire. Le refus est immediat
 * et l'agent corrige tout seul.
 */
let roster: Set<string> | null = null;

function knownAgents(): Set<string> {
  if (roster) return roster;
  try {
    roster = new Set(
      readdirSync(agentsDir())
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => entry.slice(0, -3)),
    );
  } catch {
    // Sans les definitions sous la main, on ne refuse rien : le flux vaut mieux
    // qu'un run bloque sur une verification cosmetique.
    roster = new Set();
  }
  return roster;
}

interface EventDraft {
  kind: LiveEvent["kind"];
  status: LiveEvent["status"];
  title: string;
  detail?: string | null;
  agent?: string | null;
  tool?: string | null;
  repo?: string | null;
  payload?: unknown;
  runId?: string;
  step?: string | null;
}

/**
 * Sur disque d'abord, diffuse ensuite. C'est cet ordre qui fait que le live
 * shell n'est pas un point de defaillance : s'il est mort, l'historique reste
 * complet et une reprise peut le rejouer depuis le debut.
 */
/**
 * L'etape courante, lue dans l'etat du ticket au moment du push.
 *
 * Les agents l'ecrivent tantot en chaine (« 10.4 »), tantot en nombre : les
 * deux donnent la meme etape, et l'interface a besoin des deux.
 */
function currentStep(ticketId: string): string | null {
  const state = readTicketState(ticketId) as { run?: { step?: unknown } } | null;
  const step = state?.run?.step;
  if (typeof step === "string" && step.trim()) return step.trim();
  if (typeof step === "number" && Number.isFinite(step)) return String(step);
  return null;
}

async function record(ticketId: string, draft: EventDraft): Promise<{ seq: number; persisted: boolean; delivery: string }> {
  const session = readLiveSession(ticketId);
  const candidate = {
    runId: draft.runId ?? session?.runId ?? `local-${ticketId}`,
    ticketId,
    seq: nextSeq(ticketId),
    ts: new Date().toISOString(),
    kind: draft.kind,
    status: draft.status,
    repo: draft.repo ?? null,
    agent: draft.agent ?? null,
    tool: draft.tool ?? null,
    step: draft.step ?? currentStep(ticketId),
    title: draft.title,
    detail: draft.detail ?? null,
    payload: draft.payload ?? null,
  };

  const validated = validateEvent(candidate);
  if (!validated.ok) {
    fail(`Event invalide : ${validated.issues.join(" ; ")}.`, "Un event mal forme est ignore par l'interface, autant le corriger ici.");
  }

  appendEvent(validated.event);
  const delivery = await broadcast(validated.event);
  return { seq: validated.event.seq, persisted: true, delivery };
}

async function finishQuestion(
  ticketId: string,
  agent: string | null,
  answers: Record<string, string>,
  transport: string,
): Promise<void> {
  // Un arbitrage rendu compte pour un, pas un lot pour un.
  //
  // C'etait l'inverse, au motif qu'un lot est un seul arret du workflow. Mais ce
  // compteur ne mesure pas les arrets, il mesure ce que l'humain a du trancher :
  // cinquante et une reponses affichees « 14 interventions » ne decrivent rien
  // de ce qui s'est passe. Le nombre d'arrets se lit deja dans le flux, une
  // ligne `question` par lot.
  const rendered = Object.keys(answers).length;
  patchTicketState(ticketId, {
    metrics: { humanInterventions: { __increment: rendered > 0 ? rendered : 1 } },
  });
  const summary = Object.entries(answers)
    .map(([key, value]) => `${key} = ${value}`)
    .join(" · ");
  await record(ticketId, {
    kind: "answer",
    status: "ok",
    agent,
    title: `Reponses recues (${transport}) : ${truncate(summary, 140)}`,
    detail: Object.entries(answers)
      .map(([key, value]) => `${key}\n  ${value}`)
      .join("\n\n"),
    payload: { transport, answers },
  });
}

/** Le rythme du battement : dit qu'on travaille, et verifie que le shell vit. */

/**
 * On attend une reponse aussi longtemps que la page est la pour la donner.
 *
 * **Le lot se depose, puis on revient le relever.** Il a longtemps voyage dans
 * un seul POST qu'on tenait ouvert jusqu'a la reponse, et ca ne tenait pas : le
 * client HTTP de Node abandonne une requete dont les en-tetes ne sont pas
 * arrives au bout de cinq minutes — `UND_ERR_HEADERS_TIMEOUT` — et comme
 * l'erreur ressemblait a un shell mort, le lot repartait au terminal en plein
 * cadrage. Huit heures annoncees, cinq minutes tenues.
 *
 * Aucun reglage ne repare vraiment ca. Allonger le delai du client deplace le
 * mur ; il en reste un, et il reste invisible. Ce qui le supprime, c'est de ne
 * plus rien tenir ouvert : deposer en une requete courte, revenir voir en
 * requetes courtes. Plus aucune horloge n'a de prise, et le seul plafond qui
 * reste est celui du serveur MCP — huit heures, celui qu'on voulait.
 *
 * Le retour vaut mieux que l'attente pour une deuxieme raison : un shell qui
 * redemarre pendant qu'on attend ne connait plus le lot, et le dit. On le
 * redepose, et la question survit au rechargement de la page — ce que la
 * requete tenue ouverte ne savait pas faire, puisqu'elle mourait avec lui.
 */
const POLL_MS = 2_000;
/** Combien de temps le shell peut rester injoignable avant qu'on le declare parti. */
const GRACE_MS = 60_000;

async function askLiveShell(
  url: string,
  input: {
    id: string;
    questions: { key: string; header: string; question: string; options: string[] }[];
    askedBy: string | null;
  },
  heartbeat: (message: string) => void,
): Promise<Record<string, string> | null> {
  const collected = await waitOnSlot(url, "/rpc/ask", input, input.id, heartbeat);
  return (collected?.answers as Record<string, string> | undefined) ?? null;
}

async function askPlanLiveShell(
  url: string,
  input: { id: string; repos: unknown[]; note: string | null; askedBy: string | null },
  heartbeat: (message: string) => void,
): Promise<{ verdict?: string; note?: string } | null> {
  const collected = await waitOnSlot(url, "/rpc/ask-plan", input, input.id, heartbeat);
  return (collected?.decision as { verdict?: string; note?: string } | undefined) ?? null;
}

/**
 * Deposer, puis relever jusqu'a ce qu'il y ait quelque chose — ou que la page
 * soit vraiment partie.
 *
 * « Vraiment partie » n'est pas « n'a pas repondu tout de suite » : un
 * rechargement d'onglet, une machine qui se reveille, un `vite` qui recompile
 * rendent le shell muet quelques secondes. On accorde donc une minute continue
 * d'injoignabilite avant de se replier, la ou l'ancienne version partait au
 * bout de deux sondes ratees.
 */
async function waitOnSlot(
  url: string,
  route: string,
  body: unknown,
  id: string,
  heartbeat: (message: string) => void,
): Promise<{ answers?: unknown; decision?: unknown } | null> {
  if (!(await postJson(`${url}${route}`, body))) return null;

  const since = Date.now();
  let unreachableSince: number | null = null;
  let lastBeat = Date.now();

  heartbeat("En attente de ta reponse dans le live shell.");

  for (;;) {
    await wait(POLL_MS);
    const slot = await getJson<{ status: string; answers?: unknown; decision?: unknown }>(
      `${url}/rpc/collect?id=${encodeURIComponent(id)}`,
    );

    if (slot === null) {
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince > GRACE_MS) return null;
      continue;
    }
    unreachableSince = null;

    if (slot.status === "answered") return slot;
    // Le shell a redemarre : il ne connait plus le lot, on le redepose tel quel.
    if (slot.status === "gone" && !(await postJson(`${url}${route}`, body))) return null;
    if (slot.status === "withdrawn") return null;

    // Le battement dit au client qu'on travaille encore. Il ne repousse pas le
    // plafond de l'appel, il nourrit le chien de garde d'inactivite.
    if (Date.now() - lastBeat >= 20_000) {
      lastBeat = Date.now();
      const minutes = Math.round((Date.now() - since) / 60_000);
      heartbeat(
        minutes < 1
          ? "En attente de ta reponse dans le live shell."
          : `En attente de ta reponse dans le live shell depuis ${minutes} min.`,
      );
    }
  }
}

async function postJson(url: string, body: unknown): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best effort : si le shell ne repond deja plus, il n'a plus de lot a retirer. */
async function withdrawFromLiveShell(url: string, id: string): Promise<void> {
  try {
    await fetch(`${url}/rpc/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* le shell est parti : le lot est parti avec lui */
  }
}

function formatQuestions(questions: { header: string; question: string; options: string[] }[]): string {
  return questions
    .map((entry) => {
      const options = entry.options.length > 0 ? `\n${entry.options.map((option) => `- ${option}`).join("\n")}` : "";
      return `${entry.header}\n${entry.question}${options}`;
    })
    .join("\n\n");
}

async function isAlive(url: string, expectedTicket?: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/rpc/health`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    if (!expectedTicket) return true;
    const body = await response.json() as { ticketId?: string };
    return body.ticketId?.toUpperCase() === expectedTicket.toUpperCase();
  } catch {
    return false;
  }
}

async function waitFor(url: string, timeoutMs: number, ticketId?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAlive(url, ticketId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function findFreePort(from: number, to: number): Promise<number> {
  const span = to - from;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = from + Math.floor(Math.random() * span);
    if (await isFree(port)) return port;
  }
  fail(`Aucun port libre entre ${from} et ${to}.`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

/**
 * Le shell meurt avec la session qui l'a ouvert.
 *
 * Il est lance `detached` pour que le run survive a un tool qui plante, ce qui
 * est la bonne propriete — et qui a pour revers qu'il survit aussi a la session
 * entiere. On se retrouvait avec un serveur vite par run abandonne, sur un port
 * different a chaque fois, jusqu'au prochain redemarrage de la machine.
 *
 * Ce process-ci, lui, est un enfant de la session Claude : quand elle ferme, il
 * recoit son signal ou perd son entree standard. C'est le seul endroit du
 * systeme qui sache que la session est finie, donc c'est lui qui ramasse.
 *
 * Le groupe entier est tue, pas seulement le `pnpm` : `detached` lui donne son
 * propre groupe de process, et `pnpm` n'est qu'un parent qui a lui-meme lance
 * vite. Tuer le parent seul laisserait l'enfant qui ecoute le port.
 */
function reapWithSession(pid: number | null, ticketId: string): void {
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 1 || reaping.has(pid)) return;
  reaping.add(pid);

  reapers.add(() => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Deja parti, ou jamais demarre. Dans les deux cas il n'y a rien a tuer.
    }
    try {
      rmSync(liveSessionPath(ticketId), { force: true });
    } catch {
      // Le fichier de session est un indice, pas une source de verite.
    }
  });
}

/**
 * Ce que l'arret du serveur doit ramasser.
 *
 * Les signaux ne sont plus ecoutes ici. Ils l'etaient, et c'etait une faute
 * discrete : `process.once("SIGTERM", …)` **remplace** le comportement par
 * defaut de Node, qui est de sortir. Un serveur qui posait ce handler sans
 * appeler `exit` devenait sourd a SIGTERM et survivait a la session qui l'avait
 * ouvert. Le cycle de vie appartient maintenant a `server.ts`, en un seul
 * endroit, et lui sort vraiment.
 */
const reapers = new Set<() => void>();

export function reapLiveShells(): void {
  for (const reap of [...reapers]) {
    try {
      reap();
    } catch {
      // Le ramassage est un best effort : ce qui echoue ici n'empeche pas le reste.
    }
  }
  reapers.clear();
}

const reaping = new Set<number>();

/**
 * Le gate, par le meme chemin que les questions.
 *
 * Meme depot, meme releve, meme repli : le point 9 est le meme moment du run —
 * il s'arrete et il attend quelqu'un. Le detail vit dans `waitOnSlot`, et le
 * partager est ce qui garantit que le gate ne se remettra pas, tout seul, a
 * lacher au bout de cinq minutes le jour ou on corrige les questions.
 */
async function decideInLiveShell(
  url: string,
  input: {
    id: string;
    repos: { repo: string; level: number | null; changes: string[]; why: string | null }[];
    note: string | null;
    askedBy: string | null;
  },
  heartbeat: (message: string) => void,
): Promise<{ verdict: "approve" | "amend" | "reject"; note: string } | null> {
  const decision = await askPlanLiveShell(url, input, (message) =>
    heartbeat(message.replace("de ta reponse", "de ton verdict sur le plan")),
  );
  const verdict = decision?.verdict;
  if (verdict !== "approve" && verdict !== "amend" && verdict !== "reject") return null;
  return { verdict, note: String(decision?.note ?? "") };
}

/** Le verdict laisse une trace, et une approbation date le plan. */
async function finishPlan(
  ticketId: string,
  agent: string | null,
  decision: { verdict: "approve" | "amend" | "reject"; note: string },
  transport: string,
  submittedFingerprint: string,
): Promise<void> {
  patchTicketState(ticketId, { metrics: { humanInterventions: { __increment: 1 } } });
  if (decision.verdict === "approve") {
    recordPlanApproval(ticketId, submittedFingerprint, transport);
  }
  const said = { approve: "Plan approuve", amend: "Plan a amender", reject: "Plan rejete" }[decision.verdict];
  await record(ticketId, {
    kind: "decision",
    status: decision.verdict === "approve" ? "ok" : "ko",
    agent,
    title: decision.note ? `${said} (${transport}) : ${truncate(decision.note, 140)}` : `${said} (${transport})`,
    detail: decision.note || null,
    payload: { transport, ...decision },
  });
}

function formatPlan(
  repos: { repo: string; level: number | null; changes: string[]; why: string | null }[],
  note: string | null,
): string {
  const body = repos
    .map((entry, index) => {
      const head = `${index + 1}. ${entry.repo}${entry.level !== null ? ` (niveau ${entry.level})` : ""}`;
      const why = entry.why ? `\n   ${entry.why}` : "";
      const changes = entry.changes.map((change) => `\n   - ${change}`).join("");
      return `${head}${why}${changes}`;
    })
    .join("\n\n");
  return [note, "Le plan, dans l'ordre d'execution :", body].filter(Boolean).join("\n\n");
}

/** Le numero du point, quand on sait le lire. `-1` sinon. */
function stepIndex(step: string | null): number {
  const found = /^\s*(?:point\s*)?(\d{1,2})/i.exec(String(step ?? ""));
  return found?.[1] ? Number(found[1]) : -1;
}
