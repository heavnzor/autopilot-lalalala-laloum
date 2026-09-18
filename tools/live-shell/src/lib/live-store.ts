import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type AskQuestion,
  type JsonValue,
  type LiveEvent,
  type PendingPlan,
  type PendingQuestion,
  type PlanDecision,
  type PlanRepo,
  parseEvent,
} from "./event.ts";

/**
 * L'etat du shell, en memoire, cote serveur.
 *
 * Le shell est une fenetre sur un run, pas un pilote. Il ne detient donc aucune
 * verite : tout ce qu'il affiche vient du flux d'events, et le flux est deja sur
 * disque avant d'arriver ici. S'il meurt, on le relance et il rejoue.
 */

type Subscriber = (payload: string) => void;

const events: LiveEvent[] = [];
const subscribers = new Set<Subscriber>();
/**
 * Un seul mecanisme de blocage, deux formes de chose en attente.
 *
 * Un lot de questions et un plan a approuver sont le meme moment du run : il
 * s'arrete et il attend quelqu'un. Ils partagent donc la meme table, le meme
 * retrait, le meme repli terminal — ouvrir un second canal aurait fait deux
 * mecaniques a tenir en phase pour une seule verite.
 *
 * **Ce n'est plus une promesse tenue ouverte, c'est un casier qu'on releve.**
 * Le tool deposait sa question dans un POST qui ne rendait la main qu'a la
 * reponse — une requete HTTP maintenue pendant des heures. Elle ne tenait pas :
 * le client HTTP de Node coupe une requete dont les en-tetes n'arrivent pas au
 * bout de cinq minutes, et le lot repartait au terminal en plein milieu d'un
 * cadrage. On depose maintenant, et l'appelant revient voir. Rien n'est tenu
 * ouvert, donc rien ne peut etre coupe.
 */
type Waiting =
  | { kind: "questions"; question: PendingQuestion; answers: Record<string, string> | null }
  | { kind: "plan"; plan: PendingPlan; decision: PlanDecision | null };

/**
 * L'etat d'un casier, vu par celui qui l'a depose.
 *
 * `gone` est le seul qui demande quelque chose : le shell a redemarre et ne
 * connait plus ce lot. L'appelant le redepose alors tel quel, et la question
 * survit au redemarrage de la page — ce que la promesse tenue ouverte ne
 * savait pas faire, puisqu'elle mourait avec le process.
 */
export type SlotStatus = "pending" | "answered" | "withdrawn" | "gone";

const pending = new Map<string, Waiting>();
/** Les lots releves ou retires, gardes pour que l'appelant sache lequel des deux. */
const settled = new Map<string, { status: Exclude<SlotStatus, "pending" | "gone">; at: number; answers?: Record<string, string>; decision?: PlanDecision }>();
const ignored: { at: string; reason: string }[] = [];

let ticketId: string | null = process.env.AUTOPILOT_TICKET_ID ?? null;
let replayStamp = "";

function autopilotHome(): string {
  return process.env.AUTOPILOT_HOME ?? join(homedir(), ".autopilot");
}

/**
 * Le rejeu. Si `/autopilot-start` reprend un ticket interrompu, on doit pouvoir
 * arriver en cours de route et comprendre ce qui s'est passe — donc l'historique
 * complet, depuis le debut, avant de se brancher sur le direct.
 */
export function replay(): void {
  if (!ticketId) return;
  let raw = "";
  try {
    const path = join(autopilotHome(), "events", `${ticketId}.jsonl`);
    const stat = statSync(path);
    const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (stamp === replayStamp) return;
    raw = readFileSync(path, "utf8");
    replayStamp = stamp;
  } catch {
    return;
  }
  const known = new Set(events.map((event) => `${event.runId}:${event.seq}`));
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = parseEvent(JSON.parse(line));
      if (event && event.ticketId.toUpperCase() === ticketId.toUpperCase()) {
        const id = `${event.runId}:${event.seq}`;
        if (!known.has(id)) { events.push(event); known.add(id); }
      }
      else
        ignored.push({
          at: new Date().toISOString(),
          reason: "event invalide au rejeu",
        });
    } catch {
      ignored.push({
        at: new Date().toISOString(),
        reason: "ligne jsonl illisible",
      });
    }
  }
  events.sort((a, b) => a.seq - b.seq);
}

export function ingest(candidate: unknown): {
  accepted: boolean;
  reason?: string;
} {
  const event = parseEvent(candidate);
  if (!event) {
    const reason = "event invalide, ignore";
    ignored.push({ at: new Date().toISOString(), reason });
    // eslint-disable-next-line no-console
    console.warn("[live-shell]", reason, JSON.stringify(candidate)?.slice(0, 300));
    return { accepted: false, reason };
  }
  if (ticketId && event.ticketId.toUpperCase() !== ticketId.toUpperCase()) return { accepted: false, reason: "ticket etranger a cette session" };
  ticketId ??= event.ticketId;
  // Un event deja vu au rejeu ne doit pas apparaitre deux fois.
  if (!events.some((existing) => existing.runId === event.runId && existing.seq === event.seq)) {
    events.push(event);
  }
  broadcast("event", event);
  return { accepted: true };
}

/**
 * L'etat du ticket, lu sur disque a chaque appel.
 *
 * Le shell ne le detient pas et ne l'ecrit jamais : `write-store-ticket` en est
 * le seul ecrivain. Le relire a chaque fois evite d'entretenir ici une copie qui
 * derivera du fichier au premier crash.
 */
export function ticketState(): JsonValue | null {
  if (!ticketId) return null;
  try {
    return parseYaml(readFileSync(join(autopilotHome(), "tickets", `${ticketId}.yaml`), "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

export function snapshot(): {
  ticketId: string | null;
  ticket: JsonValue | null;
  events: LiveEvent[];
  question: PendingQuestion | null;
  plan: PendingPlan | null;
  ignored: { at: string; reason: string }[];
} {
  replay();
  return {
    ticketId,
    ticket: ticketState(),
    events: [...events],
    question: pendingQuestion(),
    plan: pendingPlan(),
    ignored: [...ignored],
  };
}

/**
 * Le PNG d'une maquette, lu sur disque.
 *
 * Le shell ne detient pas l'image et ne la telecharge pas : `get-figma-image`
 * l'a tiree au point 2 et rangee a cote de l'etat du ticket. On la sert, c'est
 * tout — la page reste une fenetre, y compris sur les pixels.
 *
 * Le nom de fichier vient de l'etat du ticket, donc d'un agent : il est traite
 * comme une entree hostile. Un seul segment, une extension connue, et le chemin
 * resolu doit rester dans le dossier du ticket.
 */
export function figmaImage(name: string): ArrayBuffer | null {
  if (!ticketId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(name) || name.includes("..")) return null;

  const dir = resolve(join(autopilotHome(), "figma", ticketId));
  const file = resolve(join(dir, name));
  if (file !== join(dir, name)) return null;

  try {
    const bytes = readFileSync(file);
    // `Buffer` est une vue sur un pool partage : on ne rend que la tranche qui
    // appartient a ce fichier, sinon la reponse emporte la memoire des voisins.
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

export function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  watchTicket();
  return () => subscribers.delete(subscriber);
}

/**
 * Le shell surveille l'etat du ticket lui-meme.
 *
 * Il ne le relisait que quand un event d'un certain kind passait — `step`,
 * `escalation`, `answer`. Les agents poussent surtout des `agent` et des
 * `tool`, alors la page restait sur la frame de son chargement : `run.step`
 * passait a 2 puis a 3 sur le disque pendant qu'elle affichait encore
 * « Lecture du ticket », sans que rien n'ait l'air casse.
 *
 * Faire dependre l'exactitude de la page de ce qu'un agent pense a pousser,
 * c'est faire du shell un point de defaillance de sa propre lecture. Le
 * fichier est la, il lui appartient, il le regarde. Un `stat` par seconde.
 */
let ticketWatch: ReturnType<typeof setInterval> | null = null;
let ticketStamp = "";

function watchTicket(): void {
  if (ticketWatch) return;
  ticketWatch = setInterval(() => {
    if (!ticketId) return;
    let stamp: string;
    try {
      const stat = statSync(join(autopilotHome(), "tickets", `${ticketId}.yaml`));
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Pas encore ecrit : il n'y a rien a diffuser, et ce n'est pas une panne.
      return;
    }
    if (stamp === ticketStamp) return;
    ticketStamp = stamp;
    broadcast("ticket", ticketState());
  }, 1000);
  // Le timer ne doit pas retenir le process : le shell se coupe avec son onglet.
  ticketWatch.unref?.();
}

function broadcast(type: string, data: unknown): void {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const subscriber of subscribers) {
    try {
      subscriber(payload);
    } catch {
      subscribers.delete(subscriber);
    }
  }
}

// --------------------------------------------------------------- ask-user ----

/**
 * `ask-user` bloque la session Claude : il depose la question et revient la
 * relever. Le blocage est reel — le workflow n'avance pas — mais il est tenu
 * par une boucle chez l'appelant, pas par une requete HTTP ouverte.
 */
export function ask(input: {
  questions: readonly AskQuestion[];
  askedBy: string | null;
  id?: string | null;
}): PendingQuestion {
  const existing = input.id ? pending.get(input.id) : null;
  if (existing?.kind === "questions") return existing.question;
  const entry: PendingQuestion = {
    questions: input.questions,
    askedBy: input.askedBy,
    // L'appelant fournit l'identifiant : c'est lui qui reviendra relever le
    // casier, et il ne peut pas le faire sans le connaitre avant la reponse.
    id: input.id?.trim() || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    askedAt: new Date().toISOString(),
    answerable: true,
  };
  if (settled.has(entry.id)) return { ...entry, answerable: false };
  pending.set(entry.id, { kind: "questions", question: entry, answers: null });
  settled.delete(entry.id);
  broadcast("question", entry);
  return entry;
}

/**
 * Le plan soumis au gate, par le meme chemin que les questions.
 *
 * Le point 9 passait par `ask-user` : cinq questions dont on avait oublie la
 * premiere en repondant a la derniere, pour valider un objet qui se lit sur une
 * page. Il a maintenant sa forme, et c'est la seule chose qui change — le
 * depot, le retrait et le repli restent ceux des questions.
 */
export function askPlan(input: {
  repos: readonly PlanRepo[];
  note: string | null;
  askedBy: string | null;
  id?: string | null;
}): PendingPlan {
  const existing = input.id ? pending.get(input.id) : null;
  if (existing?.kind === "plan") return existing.plan;
  const entry: PendingPlan = {
    repos: input.repos,
    note: input.note,
    askedBy: input.askedBy,
    id: input.id?.trim() || `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    askedAt: new Date().toISOString(),
    answerable: true,
  };
  if (settled.has(entry.id)) return { ...entry, answerable: false };
  pending.set(entry.id, { kind: "plan", plan: entry, decision: null });
  settled.delete(entry.id);
  broadcast("plan", entry);
  return entry;
}

/**
 * Relever le casier.
 *
 * Une releve est idempotente : perdre la reponse HTTP ne doit pas perdre la
 * decision humaine. Le casier quitte les questions actives, mais sa reponse
 * reste disponible pendant la vie de cette session.
 */
export function collect(id: string): {
  status: SlotStatus;
  answers?: Record<string, string>;
  decision?: PlanDecision;
} {
  const entry = pending.get(id);
  if (entry) {
    if (entry.kind === "questions" && entry.answers) {
      pending.delete(id);
      settled.set(id, { status: "answered", at: Date.now(), answers: entry.answers });
      return { status: "answered", answers: entry.answers };
    }
    if (entry.kind === "plan" && entry.decision) {
      pending.delete(id);
      settled.set(id, { status: "answered", at: Date.now(), decision: entry.decision });
      return { status: "answered", decision: entry.decision };
    }
    return { status: "pending" };
  }

  const done = settled.get(id);
  if (done) return { status: done.status, ...(done.answers ? { answers: done.answers } : {}), ...(done.decision ? { decision: done.decision } : {}) };
  // Inconnu : le shell a redemarre depuis le depot. L'appelant redepose.
  return { status: "gone" };
}

/**
 * Le retrait d'un lot que l'appelant a repris ailleurs.
 *
 * Sans ce retrait, le lot restait affiche pour toujours : on repondait dans une
 * page a un run qui attendait deja la meme reponse dans un terminal, et le clic
 * ne resolvait rien du tout.
 */
export function withdraw(id: string): { withdrawn: boolean } {
  const entry = pending.get(id);
  if (!entry) return { withdrawn: false };
  pending.delete(id);
  settled.set(id, { status: "withdrawn", at: Date.now() });
  broadcast("withdraw", { id });
  return { withdrawn: true };
}

/**
 * Le verdict du gate.
 *
 * `amend` et `reject` exigent une note : un plan renvoye sans dire ce qui cloche
 * renvoie le planner sur la meme hypothese, et on recommence. `approve` n'en
 * demande pas — il n'y a rien a expliquer quand on dit oui.
 */
export function decide(id: string, decision: PlanDecision): { delivered: boolean; missing: boolean } {
  const entry = pending.get(id);
  if (!entry || entry.kind !== "plan") return { delivered: false, missing: false };
  if (decision.verdict !== "approve" && !decision.note.trim()) {
    return { delivered: false, missing: true };
  }

  // On garde le casier jusqu'a ce que l'appelant vienne le relever : c'est lui
  // qui debloque le run, et l'effacer ici perdrait le verdict entre deux tours.
  entry.decision = decision;
  broadcast("decision", { id, ...decision });
  return { delivered: true, missing: false };
}

/**
 * Le lot retrouve dans le journal, quand la memoire ne l'a plus.
 *
 * Un shell relance au milieu d'un lot doit quand meme montrer ce qui bloque le
 * run — sinon la page affiche un run au repos alors qu'il attend. Il le montre
 * en lecture seule : les questions sont vraies, le canal pour y repondre ne
 * l'est plus.
 */
function replayedQuestion(): PendingQuestion | null {
  const last = [...events].reverse().find((event) => event.kind === "question" || event.kind === "answer");
  if (!last || last.kind !== "question") return null;

  const payload = (last.payload ?? {}) as { questions?: AskQuestion[] };
  const questions = (payload.questions ?? []).filter((entry) => entry?.question);
  if (questions.length === 0) return null;

  return {
    id: `replayed-${last.seq}`,
    questions,
    askedBy: last.agent,
    askedAt: last.ts,
    answerable: false,
  };
}

/**
 * Le lot ne se rend que complet.
 *
 * Repondre a deux questions sur trois debloquerait le workflow sur une reponse
 * manquante, et l'agent repartirait sur une hypothese — exactement ce que le
 * blocage sert a empecher.
 */
export function answer(
  id: string,
  answers: Record<string, string>,
): { delivered: boolean; missing: string[] } {
  const entry = pending.get(id);
  if (!entry || entry.kind !== "questions") return { delivered: false, missing: [] };

  const missing = entry.question.questions
    .filter((question) => typeof answers[question.key] !== "string" || !answers[question.key]?.trim())
    .map((question) => question.key);
  if (missing.length > 0) return { delivered: false, missing };

  // Le casier reste en place jusqu'a ce que l'appelant le releve : c'est cette
  // releve qui debloque le run. L'effacer ici perdrait la reponse dans
  // l'intervalle entre le clic et le tour de boucle suivant.
  entry.answers = answers;
  broadcast("answer", { id, answers });
  return { delivered: true, missing: [] };
}

// Un casier deja rempli n'attend plus personne : il attend d'etre releve, ce
// qui n'est pas la meme chose. Le montrer reposerait la question a qui
// rechargerait la page dans la seconde suivant sa reponse.
export function pendingQuestion(): PendingQuestion | null {
  for (const entry of pending.values()) {
    if (entry.kind === "questions" && !entry.answers) return entry.question;
  }
  return replayedQuestion();
}

export function pendingPlan(): PendingPlan | null {
  for (const entry of pending.values()) if (entry.kind === "plan" && !entry.decision) return entry.plan;
  return replayedPlan();
}

/**
 * Le plan retrouve dans le journal, quand la memoire ne l'a plus.
 *
 * Meme raison que pour un lot de questions : un shell relance pendant le gate
 * doit montrer ce qui bloque, en lecture seule. Les boutons seraient un
 * mensonge — la promesse qui tient le workflow est morte avec l'ancien process.
 */
function replayedPlan(): PendingPlan | null {
  const last = [...events].reverse().find((event) => event.kind === "plan" || event.kind === "decision");
  if (!last || last.kind !== "plan") return null;

  const payload = (last.payload ?? {}) as { repos?: PlanRepo[]; note?: string };
  const repos = (payload.repos ?? []).filter((entry) => entry?.repo);
  if (repos.length === 0) return null;

  return {
    id: `replayed-${last.seq}`,
    repos,
    note: payload.note ?? null,
    askedBy: last.agent,
    askedAt: last.ts,
    answerable: false,
  };
}
