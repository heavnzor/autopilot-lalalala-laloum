#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolRequest,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type RequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
import { ToolError } from "./lib/errors.ts";
import { validate } from "./lib/schema.ts";
import type { ToolContext } from "./lib/tool.ts";
import { killRunningCommands } from "./lib/exec.ts";
import { ALL_TOOLS, toolByName } from "./registry.ts";
import { reapLiveShells } from "./tools/human.ts";

/**
 * Le serveur de tools de l'autopilot.
 *
 * Il ne decide rien : il valide une entree, appelle une fonction, rend un
 * resultat. Tout ce qui juge est dans un agent, tout ce qui est constant est
 * ici.
 */

const server = new Server(
  { name: "autopilot", version: "2.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: ALL_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const tool = toolByName(request.params.name);
  if (!tool) {
    return errorResult(`Tool inconnu : ${request.params.name}.`, `Tools disponibles : ${ALL_TOOLS.map((t) => t.name).join(", ")}`);
  }

  const input = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    validate(tool.inputSchema, input, tool.name);
    const output = await tool.handler(input, context(request, extra));
    return {
      content: [{ type: "text" as const, text: stringify(output) }],
    };
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error.message, error.hint);
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`${tool.name} a echoue : ${message}`, error instanceof Error ? error.stack?.split("\n")[1]?.trim() ?? null : null);
  }
});

/**
 * Ce qu'un tool peut demander au client : parler a l'humain, et dire qu'il
 * travaille encore.
 *
 * Le second point n'est pas du confort. Un appel MCP qui ne dit rien pendant dix
 * minutes est un appel que le client considere comme perdu, et `ask-user` attend
 * par construction aussi longtemps qu'il faut. La progression est la seule chose
 * du protocole qui remette ce compteur a zero.
 */
function context(request: CallToolRequest, extra: RequestExtra): ToolContext {
  const capabilities = server.getClientCapabilities();
  const canAskHuman = Boolean(capabilities?.elicitation);
  const progressToken = request.params._meta?.progressToken;

  return {
    canAskHuman,
    heartbeat: (message) => {
      // Sans jeton, le client n'a pas demande de progression : se taire est la
      // bonne reponse, pas une erreur a remonter.
      if (progressToken === undefined) return;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: Date.now(), message },
        })
        .catch(() => {
          // Le transport est parti. Le tool, lui, continue : c'est le run qui
          // compte, pas la barre de progression.
        });
    },
    askHuman: async (message, fields) => {
      const properties: Record<string, { type: "string"; title?: string; description?: string }> = {};
      for (const [key, field] of Object.entries(fields)) {
        properties[key] = { type: "string", title: field.title, description: field.description };
      }
      const result = await server.elicitInput({
        message,
        requestedSchema: { type: "object", properties, required: Object.keys(fields) },
      });
      return {
        action: result.action,
        content: (result.content ?? null) as Record<string, unknown> | null,
      };
    },
  };
}

function stringify(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output, replaceUndefined, 2);
}

function replaceUndefined(_key: string, value: unknown): unknown {
  return value === undefined ? null : value;
}

function errorResult(message: string, hint: string | null) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: hint ? `${message}\n\n${hint}` : message }],
  };
}

/**
 * La fin de vie du serveur, en un seul endroit.
 *
 * Il n'y en avait aucune : le process ne sortait jamais de lui-meme. Quand la
 * session Claude mourait sans lui envoyer de signal — terminal ferme, crash —
 * il restait la, orphelin, avec tout ce qu'il avait lance. Quatorze serveurs
 * vivants ont ete comptes un jeudi, le plus ancien datant du mardi precedent,
 * et avec eux les runners de tests qu'ils n'avaient plus personne pour tuer.
 *
 * **La fermeture de `stdin` est le signal qui compte.** C'est ainsi qu'un
 * client MCP s'en va, proprement ou non : le tube se ferme. Les signaux ne
 * couvrent que le depart poli, et un `kill -9` ne se couvre pas — rien ne
 * s'execute apres lui, et c'est la seule fuite qui reste possible.
 */
let leaving = false;

function shutdown(code: number): void {
  if (leaving) return;
  leaving = true;
  // L'ordre compte : les commandes d'abord, parce que ce sont elles qui
  // tiennent un CPU, le shell ensuite, qui ne tient qu'un port.
  killRunningCommands();
  reapLiveShells();
  // On laisse partir les SIGTERM avant de quitter : sortir dans la foulee
  // laisserait les groupes vivants une poignee de millisecondes de trop.
  // Le kill des commandes passe a SIGKILL apres deux secondes. Sortir avant
  // annulerait ce dernier recours et laisserait survivre les processus sourds.
  setTimeout(() => process.exit(code), 2_300);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(0));
}
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
// Une erreur non rattrapee ne doit pas laisser un orphelin derriere elle.
process.on("uncaughtException", (error) => {
  console.error("[autopilot] exception non rattrapee :", error);
  shutdown(1);
});

await server.connect(new StdioServerTransport());
