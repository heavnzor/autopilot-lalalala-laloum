import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import {
  answer,
  ask,
  askPlan,
  collect,
  decide,
  figmaImage,
  ingest,
  replay,
  snapshot,
  subscribe,
  withdraw,
} from "./lib/live-store.ts";

/**
 * Entree serveur du live shell.
 *
 * Trois canaux, tous locaux :
 *
 * | Sens                       | Canal                         |
 * |----------------------------|-------------------------------|
 * | session Claude -> app      | rpc POST /rpc/event           |
 * | app -> navigateur          | SSE /rpc/stream               |
 * | app -> session Claude      | GET /rpc/collect, par releve  |
 *
 * Le troisieme canal etait la reponse d'un POST tenu ouvert jusqu'a ce que
 * l'humain reponde. Une requete HTTP ne dure pas des heures : le client de
 * l'appelant coupe a cinq minutes, et le lot repartait au terminal en plein
 * cadrage. Le lot se depose maintenant en une requete courte, et l'appelant
 * revient le relever — rien n'est tenu ouvert, donc rien ne peut etre coupe.
 *
 * Tout le reste part au rendu SSR du routeur.
 */

const ssr = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, ...rest: unknown[]): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/rpc/")) {
      return rpc(url.pathname, request);
    }

    // Les maquettes rendues au point 2. Servies depuis `~/.autopilot`, jamais
    // depuis le bundle : elles appartiennent au run, pas a l'application.
    if (url.pathname.startsWith("/maquette/")) {
      const image = figmaImage(decodeURIComponent(url.pathname.slice("/maquette/".length)));
      if (!image) return json({ error: "Maquette introuvable" }, 404);
      return new Response(image, {
        headers: {
          "content-type": "image/png",
          // Le fichier ne change jamais sous un nom donne : il est ecrit une
          // fois au point 2, et un nouveau rendu porterait un autre node.
          "cache-control": "private, max-age=31536000, immutable",
        },
      });
    }

    // @ts-expect-error — la signature exacte du handler varie avec l'adaptateur.
    return ssr(request, ...rest);
  },
};

async function rpc(pathname: string, request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "Origine etrangere refusee" }, 403);
  if (request.method === "POST" && !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "application/json attendu" }, 415);
  }
  switch (pathname) {
    case "/rpc/health":
      return json({ ok: true, ticketId: process.env.AUTOPILOT_TICKET_ID ?? null, at: new Date().toISOString() });

    case "/rpc/state": {
      replay();
      return json(snapshot());
    }

    case "/rpc/event": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = await safeJson(request);
      const result = ingest(body);
      return json(result, result.accepted ? 200 : 202);
    }

    case "/rpc/ask": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = (await safeJson(request)) as {
        id?: string | null;
        questions?: {
          key?: string;
          header?: string;
          question?: string;
          options?: string[];
        }[];
        askedBy?: string | null;
      } | null;

      if (!Array.isArray(body?.questions) || body.questions.some((entry) => entry?.options !== undefined && !Array.isArray(entry.options))) return json({ error: "Lot de questions invalide" }, 400);
      const questions = body.questions
        .filter((entry) => typeof entry?.question === "string" && entry.question.trim())
        .map((entry, index) => ({
          key: entry.key?.trim() || `q${index + 1}`,
          header: entry.header?.trim() || `Question ${index + 1}`,
          question: String(entry.question).trim(),
          options: (entry.options ?? []).map(String).filter(Boolean),
        }));

      if (questions.length === 0) return json({ error: "`questions` vide" }, 400);

      // On depose et on rend la main. Tenir la reponse dans cette requete
      // paraissait plus simple — un appel, un resultat — mais une requete HTTP
      // n'est pas faite pour durer huit heures : le client de l'appelant coupe
      // au bout de cinq minutes et le lot repart au terminal en plein cadrage.
      // Le blocage du workflow est reel, il est juste tenu ailleurs.
      const batch = ask({
        questions,
        askedBy: body?.askedBy ?? null,
        id: body?.id ?? null,
      });
      return json({ id: batch.id, status: "pending" });
    }

    // La releve, pour les deux formes. Courte par construction : elle rend
    // l'etat du casier, jamais une attente.
    case "/rpc/collect": {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return json({ error: "`id` requis" }, 400);
      return json(collect(id));
    }

    case "/rpc/ask-plan": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = (await safeJson(request)) as {
        id?: string | null;
        repos?: { repo?: string; level?: number; changes?: string[]; why?: string }[];
        note?: string | null;
        askedBy?: string | null;
      } | null;

      if (!Array.isArray(body?.repos) || body.repos.some((entry) => entry?.changes !== undefined && !Array.isArray(entry.changes))) return json({ error: "Plan invalide" }, 400);
      const repos = body.repos
        .filter((entry) => typeof entry?.repo === "string" && entry.repo.trim())
        .map((entry) => ({
          repo: String(entry.repo).trim(),
          level: typeof entry.level === "number" ? entry.level : null,
          changes: (entry.changes ?? []).map(String).filter(Boolean),
          why: entry.why?.trim() || null,
        }));

      if (repos.length === 0) return json({ error: "`repos` vide" }, 400);

      // Meme depot que les questions, pour la meme raison : le point 9 est un
      // arret du workflow, pas une requete HTTP qu'on tient ouverte.
      const submitted = askPlan({
        repos,
        note: body?.note?.trim() || null,
        askedBy: body?.askedBy ?? null,
        id: body?.id ?? null,
      });
      return json({ id: submitted.id, status: "pending" });
    }

    case "/rpc/decide": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = (await safeJson(request)) as { id?: string; verdict?: string; note?: string } | null;
      const verdict = body?.verdict;
      if (!body?.id || (verdict !== "approve" && verdict !== "amend" && verdict !== "reject")) {
        return json({ error: "`id` et `verdict` requis" }, 400);
      }
      const result = decide(body.id, { verdict, note: String(body.note ?? "") });
      return json(result, result.delivered ? 200 : 409);
    }

    case "/rpc/withdraw": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = (await safeJson(request)) as { id?: string } | null;
      if (!body?.id) return json({ error: "`id` requis" }, 400);
      return json(withdraw(body.id));
    }

    case "/rpc/answer": {
      if (request.method !== "POST") return json({ error: "POST attendu" }, 405);
      const body = (await safeJson(request)) as {
        id?: string;
        answers?: Record<string, string>;
      } | null;
      if (!body?.id || typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers) || Object.values(body.answers).some((value) => typeof value !== "string")) {
        return json({ error: "`id` et `answers` requis" }, 400);
      }
      const result = answer(body.id, body.answers as Record<string, string>);
      return json(result, result.delivered ? 200 : 409);
    }

    case "/rpc/stream":
      return stream();

    default:
      return json({ error: `Route rpc inconnue : ${pathname}` }, 404);
  }
}

/**
 * SSE vers le navigateur. La reconnexion est automatique cote `EventSource` ;
 * a chaque reconnexion le client redemande `/rpc/state`, ce qui lui rend
 * l'historique complet et evite les trous.
 */
function stream(): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: string) => controller.enqueue(encoder.encode(payload));
      send(`retry: 2000\n\n`);
      send(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      unsubscribe = subscribe(send);
      heartbeat = setInterval(() => {
        try {
          send(`: ping\n\n`);
        } catch {
          /* le flux est ferme, cancel s'en occupe */
        }
      }, 20_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeJson(request: Request): Promise<unknown> {
  try {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
