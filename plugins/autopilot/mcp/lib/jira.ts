import { secret } from "./env.ts";
import { fail } from "./errors.ts";
import { request } from "./http.ts";

export interface JiraTicket {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string | null;
  readonly issueType: string;
  readonly status: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly links: readonly string[];
  readonly attachments: readonly { filename: string; url: string }[];
}

/** L'URL du site Jira vient de l'environnement : aucune instance n'est cablee ici. */
function siteUrl(): string {
  return secret("JIRA_SITE_URL").replace(/\/+$/, "");
}

function base(): string {
  return `${siteUrl()}/rest/api/3`;
}

/** Jira Cloud s'authentifie en Basic (e-mail + jeton), pas en Bearer. */
function headers(): Record<string, string> {
  const token = Buffer.from(`${secret("JIRA_EMAIL")}:${secret("JIRA_API_TOKEN")}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

export async function getTicket(key: string): Promise<JiraTicket> {
  const { status, data } = await request<any>(
    `${base()}/issue/${encodeURIComponent(key)}?expand=renderedFields&fields=summary,description,status,issuetype,labels,attachment,issuelinks,customfield_10000`,
    { headers: headers(), allow: [404] },
  );
  if (status === 404 || !data?.key) {
    fail(`Ticket Jira introuvable ou inaccessible : ${key}.`, "Verifie la cle et les droits du jeton.");
  }

  const description = flattenDocument(data.fields?.description);
  const site = siteUrl();

  return {
    key: data.key,
    title: data.fields?.summary ?? "",
    description,
    acceptanceCriteria: extractAcceptanceCriteria(description),
    issueType: data.fields?.issuetype?.name ?? "Task",
    status: data.fields?.status?.name ?? "",
    url: `${site}/browse/${data.key}`,
    labels: data.fields?.labels ?? [],
    links: collectUrls(description, data.fields?.attachment ?? []),
    attachments: (data.fields?.attachment ?? []).map((a: any) => ({ filename: a.filename, url: a.content })),
  };
}

export async function getTransitions(key: string): Promise<{ id: string; name: string }[]> {
  const { data } = await request<{ transitions: { id: string; to: { name: string } }[] }>(
    `${base()}/issue/${encodeURIComponent(key)}/transitions`,
    { headers: headers() },
  );
  return (data?.transitions ?? []).map((t) => ({ id: t.id, name: t.to?.name ?? "" }));
}

export async function transition(key: string, targetStatus: string): Promise<{ id: string; name: string }> {
  const current = await getTicket(key);
  if (current.status.trim().toLowerCase() === targetStatus.trim().toLowerCase()) {
    return { id: "already-applied", name: current.status };
  }
  const available = await getTransitions(key);
  const wanted = available.find((t) => t.name.trim().toLowerCase() === targetStatus.trim().toLowerCase());
  if (!wanted) {
    fail(
      `Statut « ${targetStatus} » inatteignable depuis l'etat actuel de ${key}.`,
      `Transitions possibles : ${available.map((t) => t.name).join(", ") || "aucune"}`,
    );
  }
  await request(`${base()}/issue/${encodeURIComponent(key)}/transitions`, {
    method: "POST",
    headers: headers(),
    body: { transition: { id: wanted.id } },
  });
  return wanted;
}

export async function comment(key: string, text: string): Promise<{ id: string }> {
  const { data } = await request<{ id: string }>(`${base()}/issue/${encodeURIComponent(key)}/comment`, {
    method: "POST",
    headers: headers(),
    body: { body: toDocument(text) },
  });
  return data;
}

export async function update(key: string, fields: Readonly<Record<string, unknown>>): Promise<void> {
  await request(`${base()}/issue/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: headers(),
    body: { fields },
  });
}

// ------------------------------------------------- Atlassian Document ----

/** ADF vers texte. On perd la mise en forme, on garde le sens et les liens. */
export function flattenDocument(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenDocument).join("");

  const record = node as Record<string, any>;
  if (record.type === "text") {
    const link = (record.marks ?? []).find((m: any) => m.type === "link");
    return link?.attrs?.href ? `${record.text} (${link.attrs.href})` : (record.text ?? "");
  }
  if (record.type === "hardBreak") return "\n";
  if (record.type === "inlineCard" || record.type === "blockCard") return record.attrs?.url ?? "";

  const inner = flattenDocument(record.content);
  const blocks = ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"];
  return blocks.includes(record.type) ? `${inner}\n` : inner;
}

export function toDocument(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: text.split("\n\n").map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph || " " }],
    })),
  };
}

const HEADING = /(crit[eè]res? d'acceptation|acceptance criteria|dod|definition of done)\s*:?\s*\n/i;

export function extractAcceptanceCriteria(description: string): string | null {
  const match = HEADING.exec(description);
  if (!match) return null;
  const after = description.slice(match.index + match[0].length).trim();
  return after ? after.split(/\n\s*\n/)[0]?.trim() ?? null : null;
}

const URL_PATTERN = /https?:\/\/[^\s)\]]+/g;

export function collectUrls(description: string, attachments: readonly { content?: string }[]): string[] {
  const urls = new Set<string>(description.match(URL_PATTERN) ?? []);
  for (const attachment of attachments) if (attachment.content) urls.add(attachment.content);
  return [...urls];
}
