import * as v from "valibot";
import { LiveEventSchema, type LiveEvent } from "../../../../shared/events.ts";
export { LiveEventSchema, LIVE_EVENT_KINDS, LIVE_EVENT_STATUSES } from "../../../../shared/events.ts";
export type { LiveEvent, JsonValue } from "../../../../shared/events.ts";

/**
 * Le format d'event, valide cote app.
 *
 * Un event qu'on ne sait pas valider est logge et ignore, jamais affiche a
 * moitie : une ligne tronquee dans l'interface coute plus cher que son absence,
 * parce qu'on la croit.
 *
 * Ce schema est le miroir de celui du serveur de tools. Les deux doivent bouger
 * ensemble ; le test unitaire du LiveEvent garde les deux alignes.
 */

/**
 * Le payload est libre par kind, mais il traverse le reseau et le rendu serveur :
 * il doit donc etre serialisable. `unknown` laissait passer une Date ou une Map,
 * qui arrivaient cassees de l'autre cote sans que rien ne le dise.
 */
export type LiveEventKind = LiveEvent["kind"];

export function parseEvent(candidate: unknown): LiveEvent | null {
  const result = v.safeParse(LiveEventSchema, candidate);
  return result.success ? result.output : null;
}

/**
 * Une question du lot.
 *
 * Toujours des options proposees **et** un champ libre. Les options font que
 * l'arbitrage courant se tranche d'un clic ; le champ libre existe parce qu'un
 * agent qui propose quatre reponses peut passer a cote de la bonne, et qu'on ne
 * veut pas forcer l'humain a choisir la moins fausse.
 */
export interface AskQuestion {
  /** Cle stable, c'est elle qui rapporte la reponse a la question. */
  readonly key: string;
  /** Deux ou trois mots, affiches en etiquette. */
  readonly header: string;
  readonly question: string;
  readonly options: readonly string[];
}

/**
 * Un lot de questions, pose en une fois.
 *
 * `ask-user` bloque le workflow : poser trois questions l'une apres l'autre,
 * c'est trois arrets la ou un seul suffit. On groupe tout ce qui peut etre
 * demande au meme moment.
 */
export interface PendingQuestion {
  readonly id: string;
  readonly questions: readonly AskQuestion[];
  readonly askedBy: string | null;
  readonly askedAt: string;
  /**
   * Est-ce que repondre ici debloque vraiment le run.
   *
   * Non quand le lot a ete reconstruit depuis le journal — un shell relance au
   * milieu d'un lot retrouve les questions, mais la promesse qui tient le
   * workflow est morte avec l'ancien process. Le module s'affiche alors en
   * lecture seule et renvoie au terminal : un formulaire qui ne debloque rien
   * coute plus cher que pas de formulaire, parce qu'on croit avoir repondu.
   */
  readonly answerable: boolean;
}

/**
 * Ce que le planner a prevu pour un depot.
 *
 * Structure, et pas un bloc de prose : c'est ce qui permet au gate de ressembler
 * aux autres widgets plutot qu'a un mur de texte au milieu d'eux. L'ordre des
 * `level` est celui de l'execution, amont vers aval, et c'est une information a
 * part entiere — approuver un plan, c'est aussi approuver cet ordre-la.
 */
export interface PlanRepo {
  readonly repo: string;
  readonly level: number | null;
  /** Ce qui change, une ligne par chose. */
  readonly changes: readonly string[];
  /** Pourquoi ce depot passe a ce moment-la. */
  readonly why: string | null;
}

/** Les trois sorties du gate, et elles ne se negocient pas. */
export type PlanVerdict = "approve" | "amend" | "reject";

/**
 * Le plan soumis au gate humain du point 9.
 *
 * Il passe par le meme mecanisme bloquant que les questions — meme retrait, meme
 * repli terminal — parce que c'est le meme moment : le run s'arrete et attend
 * quelqu'un. Il ne recopie ni le perimetre ni les checklists : ils ont leurs
 * widgets, et un contenu n'existe qu'a un seul endroit sur cette page.
 */
export interface PendingPlan {
  readonly id: string;
  readonly repos: readonly PlanRepo[];
  /** Ce que le planner veut dire en plus du plan lui-meme. */
  readonly note: string | null;
  readonly askedBy: string | null;
  readonly askedAt: string;
  /** Voir `PendingQuestion.answerable` : meme raison, meme consequence. */
  readonly answerable: boolean;
}

export interface PlanDecision {
  readonly verdict: PlanVerdict;
  /** Ce qu'il faut amender, ou pourquoi c'est rejete. Vide sur une approbation. */
  readonly note: string;
}
