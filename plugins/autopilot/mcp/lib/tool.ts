import type { JsonSchema } from "./schema.ts";

/**
 * Un tool est deterministe et testable. Son schema et sa sortie consomment du
 * contexte, mais sa procedure n'a plus a etre reinvente par un agent.
 * La regle qui decide : toute action faite a chaque run de facon constante est
 * un tool, pas une instruction d'agent.
 */
export interface ToolContext {
  /**
   * Pose une question a l'humain et bloque. Cablee sur l'elicitation MCP quand
   * le client la supporte ; c'est le repli terminal d'`ask-user`.
   */
  readonly askHuman: (
    message: string,
    fields: Readonly<Record<string, { title: string; description?: string }>>,
  ) => Promise<{ action: "accept" | "decline" | "cancel"; content: Record<string, unknown> | null }>;
  readonly canAskHuman: boolean;
  /**
   * Dit au client que ce tool travaille encore.
   *
   * Un tool qui bloque des heures — `ask-user` attend un humain — n'a aucun moyen
   * de le prouver : cote client, un appel MCP silencieux est un appel mort, et la
   * surveillance de flux le tue. Le `technical-grill` est tombe comme ca, a 600
   * secondes, juste en posant son premier lot.
   *
   * Le protocole a exactement ce qu'il faut pour ca : une notification de
   * progression remet le compteur a zero chez le client. Muet si le client n'a
   * pas demande de progression — c'est alors une capacite qu'il n'a pas, pas une
   * erreur.
   */
  readonly heartbeat: (message: string) => void;
}

export interface ToolDefinition<Input = Record<string, unknown>> {
  readonly name: string;
  /** Une phrase, a l'imperatif, qui dit quand l'appeler et ce qu'il rend. */
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly handler: (input: Input, context: ToolContext) => Promise<unknown> | unknown;
}

export function defineTool<Input = Record<string, unknown>>(definition: ToolDefinition<Input>): ToolDefinition<Input> {
  return definition;
}

export type AnyTool = ToolDefinition<any>;
