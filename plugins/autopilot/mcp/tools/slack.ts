import { fail } from "../lib/errors.ts";
import { slackChannelName } from "../lib/naming.ts";
import * as slack from "../lib/slack.ts";
import { arr, obj, str } from "../lib/schema.ts";
import { patchTicketState } from "../lib/store.ts";
import { type AnyTool, defineTool } from "../lib/tool.ts";
import { assertFinalAction, assertTicketChannel } from "../lib/workflow.ts";
import { publishOnce } from "../lib/operations.ts";
import { receiptPath, writeReceipt } from "../lib/receipts.ts";

export const slackTools: AnyTool[] = [
  defineTool({
    name: "get-slack-channel",
    description: "Cherche un canal par son nom. Rend null s'il n'existe pas, ce qui permet de savoir si le ticket a deja son canal.",
    inputSchema: obj({ name: str("Nom du canal, en minuscules.") }, ["name"]),
    handler: async ({ name }: { name: string }) => (await slack.findChannel(name)) ?? { found: false, name },
  }),

  defineTool({
    name: "create-slack-channel",
    description:
      "Cree le canal du ticket, un seul pour tout le ticket quel que soit le nombre de repos. Le nom est force en minuscules et tronque a 80 caracteres : Slack refuse les majuscules et l'echec serait tardif et opaque. Idempotent.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira."),
        title: str("Titre du ticket, transforme en slug."),
        name: str("Nom impose. Omis, il est construit depuis la convention."),
      },
      ["ticketId"],
    ),
    handler: async (input: { ticketId: string; title?: string; name?: string }) => {
      await assertFinalAction(input.ticketId);
      const name = input.name
        ? slackChannelName({ ticket: input.name, titre: "" })
        : slackChannelName({ ticket: input.ticketId, titre: input.title ?? "" });
      const channel = await slack.createChannel(name);
      writeReceipt(receiptPath(input.ticketId, "slack-channel.json"), channel);
      patchTicketState(input.ticketId, { publication: { slackChannel: { id: channel.id, name: channel.name } } });
      return { id: channel.id, name: channel.name };
    },
  }),

  defineTool({
    name: "invite-slack-users",
    description:
      "Invite les personnes de l'allowlist de la squad du ticket, et strictement elles. Une squad absente de bySquad retombe sur default, c'est-a-dire personne d'autre que moi — repli sur, jamais bloquant. Aucune adresse hors allowlist ne peut etre invitee, meme passee explicitement.",
    inputSchema: obj(
      {
        ticketId: str("Cle Jira. C'est son prefixe qui designe la squad."),
        channelId: str("Identifiant du canal."),
        emails: arr(
          "Sous-ensemble de l'allowlist a inviter. Omis, toute l'allowlist de la squad est invitee. Une adresse hors allowlist est refusee.",
          str("Adresse e-mail."),
        ),
      },
      ["ticketId", "channelId"],
    ),
    handler: async (input: { ticketId: string; channelId: string; emails?: string[] }) => {
      await assertTicketChannel(input.ticketId, input.channelId);
      const allowlist = slack.inviteesFor(input.ticketId);
      const allowed = new Set(allowlist.emails.map((email) => email.toLowerCase()));

      const asked = input.emails ?? [...allowlist.emails];
      const refused = asked.filter((email) => !allowed.has(email.toLowerCase()));
      if (refused.length > 0) {
        fail(
          `Hors allowlist : ${refused.join(", ")}.`,
          `Le jeton est un xoxp-, ces invitations partiraient sous ton identite. Allowlist ${allowlist.squad} : ${
            allowlist.emails.join(", ") || "vide"
          }.`,
        );
      }

      const resolved: { email: string; userId: string }[] = [];
      const unknown: string[] = [];
      for (const email of asked) {
        const userId = await slack.lookupByEmail(email);
        if (userId) resolved.push({ email, userId });
        else unknown.push(email);
      }

      if (resolved.length > 0) await publishOnce(input.ticketId, `slack-invite:${input.channelId}`, { users: resolved.map((entry) => entry.userId).sort() }, async () => {
        await slack.invite(input.channelId, resolved.map((entry) => entry.userId));
        return { invited: true };
      });
      patchTicketState(input.ticketId, {
        publication: { slackChannel: { invited: resolved.map((entry) => entry.email) } },
      });

      return {
        squad: allowlist.squad,
        invited: resolved.map((entry) => entry.email),
        unknownInSlack: unknown,
        fellBackToDefault: allowlist.fellBackToDefault,
        note: allowlist.fellBackToDefault
          ? `Squad ${allowlist.squad} absente de l'allowlist : personne d'autre que moi n'est invite. Ce n'est pas une erreur.`
          : undefined,
      };
    },
  }),

  defineTool({
    name: "post-slack-message",
    description:
      "Poste un message dans un canal, sous l'identite de l'utilisateur. Le texte doit avoir ete ecrit avec writer-voice-tone : un message qui sent l'automatisation est pire qu'un message absent.",
    inputSchema: obj({ ticketId: str("Cle Jira."), operationKey: str("Identifiant stable du message. Defaut : opening, conserve lors des reprises."), channelId: str("Identifiant du canal."), text: str("Texte du message.") }, ["ticketId", "channelId", "text"]),
    handler: async ({ ticketId, operationKey, channelId, text }: { ticketId: string; operationKey?: string; channelId: string; text: string }) => {
      await assertTicketChannel(ticketId, channelId);
      if (/@autopilot/i.test(text)) {
        fail(
          "Le marqueur @autopilot est interdit dans un message publie.",
          "C'est le marqueur par lequel l'utilisateur s'adresse a l'autopilot. L'ecrire, c'est se repondre a soi-meme en boucle dans un fil public.",
        );
      }
      return publishOnce(ticketId, `slack-message:${channelId}:${operationKey ?? "opening"}`, { text }, () => slack.postMessage(channelId, text));
    },
  }),

  defineTool({
    name: "create-slack-bookmark",
    description: "Pose une marque page sur le canal : le ticket Jira, chacune des MR, la preview quand il y en a une.",
    inputSchema: obj(
      { ticketId: str("Cle Jira."), channelId: str("Identifiant du canal."), title: str("Libelle de la marque page."), link: str("URL.") },
      ["ticketId", "channelId", "title", "link"],
    ),
    handler: async ({ ticketId, channelId, title, link }: { ticketId: string; channelId: string; title: string; link: string }) => {
      await assertTicketChannel(ticketId, channelId);
      if (!/^https?:\/\//i.test(link)) fail("Un marque-page doit etre une URL HTTP(S).");
      return publishOnce(ticketId, `slack-bookmark:${channelId}:${link}`, { title, link }, async () => {
        await slack.addBookmark(channelId, title, link);
        return { added: true, title, link };
      });
    },
  }),
];
