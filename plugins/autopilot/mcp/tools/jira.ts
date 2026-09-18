import { loadConfig, resolveBySquad, squadOf } from "../lib/config.ts";
import * as jira from "../lib/jira.ts";
import { anyValue, obj, str } from "../lib/schema.ts";
import { patchTicketState } from "../lib/store.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";
import { assertFinalAction } from "../lib/workflow.ts";
import { publishOnce } from "../lib/operations.ts";
import { fail } from "../lib/errors.ts";

export const jiraTools: AnyTool[] = [
  defineTool({
    name: "get-jira-ticket",
    description:
      "Recupere un ticket Jira : titre, description, criteres d'acceptation, type, statut, liens et pieces jointes. Echoue si le ticket n'existe pas ou n'est pas accessible — un run ne demarre pas sur un ticket fantome.",
    inputSchema: obj({ ticketId: str("Cle Jira, par exemple FT-1025.") }, ["ticketId"]),
    handler: async ({ ticketId }: { ticketId: string }) => jira.getTicket(ticketId),
  }),

  defineTool({
    name: "update-jira-ticket",
    description: "Modifie des champs d'un ticket. Reserve au finalizer.",
    inputSchema: obj(
      { ticketId: str("Cle Jira."), fields: anyValue("Champs de l'API Jira a ecrire.") },
      ["ticketId", "fields"],
    ),
    handler: async ({ ticketId, fields }: { ticketId: string; fields: Record<string, unknown> }) => {
      await assertFinalAction(ticketId);
      if (Object.keys(fields).some((key) => !["assignee", "labels"].includes(key))) fail("La finalisation ne modifie que l'assignation et les labels du ticket.");
      await jira.update(ticketId, fields);
      return { updated: true, ticketId, fields: Object.keys(fields) };
    },
  }),

  defineTool({
    name: "transition-jira-ticket",
    description:
      "Change le statut d'un ticket. Le statut cible se resout par squad — bySquad[squad], sinon default — et la comparaison est insensible a la casse. Une seule transition par run, au point 13.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        status: str("Statut cible. Omis, celui resolu depuis autopilot.yaml pour la squad du ticket est utilise."),
      },
      ["ticketId"],
    ),
    handler: async ({ ticketId, status }: { ticketId: string; status?: string }) => {
      await assertFinalAction(ticketId);
      const squad = squadOf(ticketId);
      const target = resolveBySquad(loadConfig().jira.transitions, squad).apresMr;
      if (status && status.trim().toLowerCase() !== target.trim().toLowerCase()) fail("La transition doit correspondre au statut configure pour la squad.");
      const applied = await jira.transition(ticketId, target);
      const at = new Date().toISOString();
      patchTicketState(ticketId, { publication: { jiraTransition: { to: applied.name, at } } });
      return { transitioned: true, squad, to: applied.name, at };
    },
  }),

  defineTool({
    name: "create-jira-comment",
    description:
      "Ajoute un commentaire au ticket. Sert a republier les questions arbitrees au functional-grill, pour que la decision vive la ou l'equipe la cherchera. Le texte passe d'abord par writer-voice-tone.",
    inputSchema: obj({ ticketId: str("Cle Jira."), operationKey: str("Identifiant stable du commentaire. Defaut : final-summary, conserve lors des reprises."), body: str("Corps du commentaire, en francais.") }, ["ticketId", "body"]),
    handler: async ({ ticketId, operationKey, body }: { ticketId: string; operationKey?: string; body: string }) => {
      await assertFinalAction(ticketId);
      const created = await publishOnce(ticketId, `jira-comment:${operationKey ?? "final-summary"}`, { body }, () => jira.comment(ticketId, body));
      return { commented: true, id: created?.id ?? null };
    },
  }),
];
