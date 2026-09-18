import { loadConfig, resolveBySquad, squadOf } from "./config.ts";
import { optionalSecret, secret } from "./env.ts";
import { fail } from "./errors.ts";
import { request } from "./http.ts";

/**
 * Le jeton est un `xoxp-` : canal, invitations et messages sont emis sous mon
 * identite. Rien ici ne doit pouvoir sortir de l'allowlist.
 */

function base(): string {
  return (optionalSecret("SLACK_API_BASE") ?? "https://slack.com/api").replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  return { authorization: `Bearer ${secret("SLACK_USER_TOKEN")}` };
}

async function call<T>(method: string, payload: Readonly<Record<string, unknown>>): Promise<T> {
  const { data } = await request<{ ok: boolean; error?: string } & T>(`${base()}/${method}`, {
    method: "POST",
    headers: headers(),
    body: payload,
  });
  if (!data?.ok) fail(`Slack ${method} a refuse : ${data?.error ?? "reponse illisible"}.`);
  return data;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
}

export async function findChannel(name: string): Promise<Channel | null> {
  let cursor = "";
  const seen = new Set<string>();
  do {
    if (seen.has(cursor)) fail("Pagination Slack circulaire.");
    seen.add(cursor);
    const { data } = await request<{ ok: boolean; error?: string; channels?: Channel[]; response_metadata?: { next_cursor?: string } }>(
      `${base()}/conversations.list?types=private_channel,public_channel&limit=200&exclude_archived=true&cursor=${encodeURIComponent(cursor)}`,
      { headers: headers() },
    );
    if (!data?.ok) fail(`Slack conversations.list a refuse : ${data?.error ?? "reponse illisible"}.`);
    const channel = data.channels?.find((entry) => entry.name === name);
    if (channel) return channel;
    cursor = data.response_metadata?.next_cursor?.trim() ?? "";
  } while (cursor);
  return null;
}

export async function createChannel(name: string): Promise<Channel> {
  const existing = await findChannel(name);
  if (existing) return existing;
  const isPrivate = loadConfig().slack.channelVisibility === "private";
  try {
    const data = await call<{ channel: Channel }>("conversations.create", { name, is_private: isPrivate });
    return data.channel;
  } catch (error) {
    if (error instanceof Error && error.message.includes("name_taken")) {
      const found = await findChannel(name);
      if (found) return found;
    }
    throw error;
  }
}

export async function lookupByEmail(email: string): Promise<string | null> {
  const { data } = await request<{ ok: boolean; user?: { id: string } }>(
    `${base()}/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: headers() },
  );
  return data?.ok ? (data.user?.id ?? null) : null;
}

export async function invite(channelId: string, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  await call("conversations.invite", { channel: channelId, users: userIds.join(",") });
}

export async function postMessage(channelId: string, text: string): Promise<{ ts: string }> {
  const data = await call<{ ts: string }>("chat.postMessage", { channel: channelId, text, unfurl_links: false });
  return { ts: data.ts };
}

export async function addBookmark(channelId: string, title: string, link: string): Promise<void> {
  await call("bookmarks.add", { channel_id: channelId, title, type: "link", link });
}

/**
 * La liste des invites, et rien d'autre.
 *
 * Une squad absente de `bySquad` retombe sur `default`, c'est-a-dire une liste
 * vide : le createur du canal y est deja, donc « vide » veut dire « personne
 * d'autre que moi ». Repli sur, jamais bloquant — un ticket d'une squad
 * nouvelle ne doit pas faire echouer un run, juste ne prevenir personne.
 */
export function inviteesFor(ticketKey: string): { squad: string; emails: readonly string[]; fellBackToDefault: boolean } {
  const squad = squadOf(ticketKey);
  const { invitees } = loadConfig().slack;
  const matched = Object.keys(invitees.bySquad ?? {}).some((key) => key.trim().toLowerCase() === squad.toLowerCase());
  return {
    squad,
    emails: resolveBySquad(invitees, squad),
    fellBackToDefault: !matched,
  };
}
