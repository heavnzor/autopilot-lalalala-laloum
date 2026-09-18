import { findRepo, loadConfig } from "../lib/config.ts";
import { fail } from "../lib/errors.ts";
import * as gl from "../lib/gitlab.ts";
import { mergeRequestName } from "../lib/naming.ts";
import { anyValue, arr, num, obj, str } from "../lib/schema.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";
import { assertFinalAction, assertTicketMr, assertUpstreamReady } from "../lib/workflow.ts";
import { assertVerifiedRevision } from "../lib/verification.ts";
import { publishOnce } from "../lib/operations.ts";
import { readReceipt, receiptPath, writeReceipt } from "../lib/receipts.ts";
import { patchTicketState } from "../lib/store.ts";
import { git } from "../lib/git.ts";
import { worktreePath } from "../lib/paths.ts";

export const gitlabTools: AnyTool[] = [
  defineTool({
    name: "get-gitlab-branch",
    description: "Recupere une branche distante et son dernier commit. Rend null si la branche n'existe pas encore.",
    inputSchema: obj({ repo: str("Nom du repo du registre."), branch: str("Nom de la branche.") }, ["repo", "branch"]),
    handler: async ({ repo, branch }: { repo: string; branch: string }) =>
      gl.getBranch(findRepo(repo).gitlabProject, branch) ?? null,
  }),

  defineTool({
    name: "get-gitlab-mr",
    description:
      "Lit une merge request, par numero ou par branche source. Rend null si elle n'existe pas : c'est le moyen de savoir si le point 13 a deja publie ce repo.",
    inputSchema: obj(
      { repo: str("Nom du repo."), iid: num("Numero de la MR."), branch: str("Branche source, si le numero est inconnu.") },
      ["repo"],
    ),
    handler: async ({ repo, iid, branch }: { repo: string; iid?: number; branch?: string }) => {
      const project = findRepo(repo).gitlabProject;
      if (iid) return gl.getMergeRequest(project, iid);
      if (branch) return gl.findMergeRequestForBranch(project, branch);
      return { error: "Donne `iid` ou `branch`." };
    },
  }),

  defineTool({
    name: "create-gitlab-mr",
    description:
      "Cree une merge request en brouillon. Reserve au finalizer. Idempotent : si une MR ouverte existe deja sur cette branche, elle est mise a jour au lieu d'etre dupliquee.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira du plan approuve."),
        repo: str("Nom du repo."),
        sourceBranch: str("Branche du worktree."),
        title: str("Titre complet. Le prefixe Draft: est ajoute s'il manque."),
        description: str("Description, en francais, reprenant les arbitrages et referencant les MR des autres repos."),
        targetBranch: str("Branche cible. Omise, la baseBranch du registre est utilisee."),
      },
      ["ticketId", "repo", "sourceBranch", "title", "description"],
    ),
    handler: async (input: {
      ticketId: string;
      repo: string;
      sourceBranch: string;
      title: string;
      description: string;
      targetBranch?: string;
    }) => {
      const repo = findRepo(input.repo);
      await assertFinalAction(input.ticketId, repo.name);
      const branch = await git(worktreePath(input.ticketId, repo.name), ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (input.sourceBranch !== branch || (input.targetBranch && input.targetBranch !== repo.baseBranch)) fail("Les branches de la MR doivent correspondre au worktree et au registre.");
      const pushed = readReceipt<{ branch: string; sha: string }>(receiptPath(input.ticketId, repo.name, "branch.json"));
      const sha = await assertVerifiedRevision(input.ticketId, repo);
      if (pushed?.branch !== branch || pushed.sha !== sha) fail("Pousse d'abord le commit verifie avec push-branch.");
      const mr = await gl.createMergeRequest({
        projectPath: repo.gitlabProject,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch ?? repo.baseBranch,
        title: input.title,
        description: input.description,
      });
      writeReceipt(receiptPath(input.ticketId, repo.name, "mr.json"), { iid: mr.iid, url: mr.web_url, branch });
      patchTicketState(input.ticketId, { publication: { mergeRequests: [{ repo: repo.name, iid: mr.iid, url: mr.web_url }] } });
      return { repo: repo.name, iid: mr.iid, url: mr.web_url, title: mr.title, draft: mr.title.startsWith("Draft: ") };
    },
  }),

  defineTool({
    name: "update-gitlab-mr",
    description:
      "Modifie une merge request existante. Sert surtout a completer les references croisees une fois que les N MR du ticket sont creees.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira du plan approuve."),
        repo: str("Nom du repo."),
        iid: num("Numero de la MR."),
        title: str("Nouveau titre."),
        description: str("Nouvelle description complete."),
        patch: anyValue("Champs bruts de l'API GitLab, pour ce que les deux champs ci-dessus ne couvrent pas."),
      },
      ["ticketId", "repo", "iid"],
    ),
    handler: async (input: { ticketId: string; repo: string; iid: number; title?: string; description?: string; patch?: Record<string, unknown> }) => {
      await assertTicketMr(input.ticketId, input.repo, input.iid);
      const allowed = new Set(["labels", "reviewer_ids", "assignee_ids"]);
      if (Object.keys(input.patch ?? {}).some((key) => !allowed.has(key))) fail("Ce patch MR contient un champ non autorise.", "Seuls labels, reviewer_ids et assignee_ids sont admis en plus du titre et de la description.");
      const body: Record<string, unknown> = { ...input.patch };
      if (input.title) body.title = loadConfig().gitlab.mrDraft && !input.title.startsWith("Draft: ") ? `Draft: ${input.title}` : input.title;
      if (input.description) body.description = input.description;
      const mr = await gl.updateMergeRequest(findRepo(input.repo).gitlabProject, input.iid, body);
      return { iid: mr.iid, url: mr.web_url, title: mr.title };
    },
  }),

  defineTool({
    name: "generate-mr-name",
    description:
      "Construit le titre d'une merge request selon la convention d'autopilot.yaml, prefixe Draft: compris. Le type doit etre celui deja retenu pour la branche du repo.",
    inputSchema: obj(
      {
        type: str("Type retenu pour ce repo : feature, bugfix, hotfix, documentation, chore, refactor, test, style, task."),
        ticketId: str("Cle Jira."),
        title: str("Titre du ticket, tel quel."),
      },
      ["type", "ticketId", "title"],
    ),
    handler: ({ type, ticketId, title }: { type: string; ticketId: string; title: string }) => ({
      title: mergeRequestName({ type, ticket: ticketId, titre: title }),
      draft: loadConfig().gitlab.mrDraft,
    }),
  }),

  defineTool({
    name: "get-gitlab-note",
    description: "Lit les notes d'une merge request : commentaires, threads et evenements systeme.",
    inputSchema: obj({ repo: str("Nom du repo."), iid: num("Numero de la MR.") }, ["repo", "iid"]),
    handler: async ({ repo, iid }: { repo: string; iid: number }) => ({
      notes: await gl.listNotes(findRepo(repo).gitlabProject, iid),
    }),
  }),

  defineTool({
    name: "create-gitlab-note",
    description: "Ecrit une note sur une merge request. Tout texte publie passe d'abord par writer-voice-tone.",
    inputSchema: obj(
      { ticketId: str("Cle Jira."), operationKey: str("Identifiant stable de cette note, conserve lors des reprises."), repo: str("Nom du repo."), iid: num("Numero de la MR."), body: str("Corps de la note, en francais.") },
      ["ticketId", "operationKey", "repo", "iid", "body"],
    ),
    handler: async ({ ticketId, operationKey, repo, iid, body }: { ticketId: string; operationKey: string; repo: string; iid: number; body: string }) => {
      await assertTicketMr(ticketId, repo, iid);
      return publishOnce(ticketId, `gitlab-note:${repo}:${iid}:${operationKey}`, { body }, () => gl.createNote(findRepo(repo).gitlabProject, iid, body));
    },
  }),

  defineTool({
    name: "create-gitlab-tag",
    description:
      "Pose un tag via l'API au point 10.7, sur le SHA verifie localement et deja accessible au remote. Pour envoyer aussi le commit local, utilise push-tag.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira du plan approuve."),
        repo: str("Nom du repo."),
        tag: str("Nom du tag."),
        ref: str("SHA complet du commit local verifie, deja present sur le remote."),
        message: str("Message annote."),
      },
      ["ticketId", "repo", "tag", "ref"],
    ),
    handler: async (input: { ticketId: string; repo: string; tag: string; ref: string; message?: string }) => {
      const repo = findRepo(input.repo);
      assertUpstreamReady(input.ticketId, repo.name);
      const sha = await assertVerifiedRevision(input.ticketId, repo);
      if (input.ref !== sha) fail("Le tag distant doit viser le SHA complet effectivement verifie.");
      const project = repo.gitlabProject;
      const existing = await gl.listTags(project);
      if (existing.includes(input.tag)) {
        return { created: false, reason: `Le tag ${input.tag} existe deja cote remote.`, existingTags: existing.slice(0, 20) };
      }
      await gl.createTag(project, input.tag, input.ref, input.message ?? input.tag);
      writeReceipt(receiptPath(input.ticketId, repo.name, "upstream.json"), { tag: input.tag, sha });
      return { created: true, tag: input.tag };
    },
  }),

  defineTool({
    name: "get-gitlab-pipeline",
    description: "Rend le dernier pipeline d'une ref et l'etat de chacun de ses jobs. Lecture seule, sans attente.",
    inputSchema: obj({ repo: str("Nom du repo."), ref: str("Branche ou tag.") }, ["repo", "ref"]),
    handler: async ({ repo, ref }: { repo: string; ref: string }) => {
      const project = findRepo(repo).gitlabProject;
      const pipeline = await gl.latestPipeline(project, ref);
      if (!pipeline) return { pipeline: null, note: "Aucun pipeline sur cette ref." };
      const jobs = await gl.pipelineJobs(project, pipeline.id);
      return { pipeline, jobs: jobs.map((job) => ({ name: job.name, status: job.status, url: job.web_url })) };
    },
  }),

  defineTool({
    name: "watch-gitlab-pipeline",
    description:
      "Attend le verdict des jobs declares dans ciJobsToWatch, avec timeout. Le verdict porte sur ces jobs, pas sur le statut global du pipeline. Un timeout n'est pas un echec de CI : c'est une escalade a l'humain.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira. Requis dans un run pour enregistrer la preuve de publication amont."),
        repo: str("Nom du repo."),
        ref: str("Branche ou tag a suivre."),
        jobs: arr("Jobs a suivre. Omis, ceux du registre sont utilises.", str("Nom de job.")),
        timeoutSeconds: num("Delai maximum. Omis, celui d'autopilot.yaml est utilise."),
        pollSeconds: num("Intervalle entre deux interrogations du pipeline. 15 par defaut."),
        expectedSha: str("SHA du commit publie. Un pipeline d'une autre revision ne valide jamais celle-ci.", { pattern: "^[a-fA-F0-9]{7,40}$" }),
      },
      ["repo", "ref"],
    ),
    handler: async (input: { ticketId?: string; repo: string; ref: string; jobs?: string[]; timeoutSeconds?: number; pollSeconds?: number; expectedSha?: string }, context) => {
      const repo = findRepo(input.repo);
      let expectedSha = input.expectedSha;
      if (input.ticketId) {
        assertUpstreamReady(input.ticketId, repo.name);
        const upstream = readReceipt<{ tag: string; sha: string }>(receiptPath(input.ticketId, repo.name, "upstream.json"));
        if (!upstream || upstream.tag !== input.ref) fail("Aucun tag amont correspondant n'a ete publie par ce run.");
        if (expectedSha && expectedSha !== upstream.sha) fail("Le SHA demande differe de celui du tag publie.");
        expectedSha = upstream.sha;
      }
      if (input.jobs && repo.ciJobsToWatch.some((job) => !input.jobs?.includes(job))) {
        fail("Le suivi CI ne peut pas retirer un job requis par le registre.");
      }
      const result = await gl.watchPipeline({
        projectPath: repo.gitlabProject,
        ref: input.ref,
        jobs: input.jobs ?? repo.ciJobsToWatch,
        timeoutSeconds: input.timeoutSeconds ?? loadConfig().timeouts.ciPipelineSeconds,
        pollSeconds: input.pollSeconds ?? 15,
        expectedSha,
        onProgress: context.heartbeat,
      });
      if (input.ticketId) writeReceipt(receiptPath(input.ticketId, repo.name, "upstream-ci.json"), {
        tag: input.ref, sha: result.pipeline?.sha ?? null, passed: result.verdict === "success", at: new Date().toISOString(),
      });
      return {
        ...result,
        watched: input.jobs ?? repo.ciJobsToWatch,
        escalate: result.verdict !== "success",
        note:
          result.verdict !== "success"
            ? "CI non validee : appelle escalate-to-human, ne bumpe pas l'aval sans tous les jobs requis au vert."
            : undefined,
      };
    },
  }),
];
