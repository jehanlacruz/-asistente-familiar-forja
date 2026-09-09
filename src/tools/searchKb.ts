import { tool } from "ai";
import { z } from "zod";
import type { Env } from "../env";

export interface SearchKbResult {
  title: string;
  content: string;
  score: number;
}

/** Callback opcional: el agente stashea los pasajes del turno (blindaje
 *  pre-envío) y el score real (selector de modelo). */
export type SearchKbOnResults = (results: SearchKbResult[]) => void;

/** Piso de score: por debajo de esto el match es RUIDO (no relacionado) y se
 *  descarta antes de dárselo al modelo. Distinto del 0.7 "match útil" que el
 *  modelo usa para decidir si escala — este solo corta basura evidente.
 *  Calibrado contra bge-m3 (cosine). */
const MIN_SCORE = 0.4;

export function searchKbTool(env: Env, onResults?: SearchKbOnResults) {
  return tool({
    description:
      "Busca en el knowledge base del negocio. Devuelve top-5 chunks con score 0-1. Si top-1 score < 0.7 no hay match útil — escala.",
    inputSchema: z.object({
      query: z.string().min(2).describe("Pregunta o tema a buscar"),
    }),
    execute: async ({ query }) => {
      try {
        const embedding = await env.AI.run("@cf/baai/bge-m3", {
          text: query,
        });
        const vec = (embedding as any).data?.[0];
        if (!Array.isArray(vec)) {
          return { error: "transient" as const, message: "embedding shape unexpected" };
        }
        const matches = await env.KB.query(vec, { topK: 5 });
        const results: SearchKbResult[] = (matches.matches ?? [])
          .map((m: any) => ({
            title: (m.metadata?.title as string) ?? "",
            content: (m.metadata?.content as string) ?? "",
            score: m.score ?? 0,
          }))
          // F2: descarta ruido (score bajo) para no aterrizar la respuesta en chunks irrelevantes.
          .filter((r) => r.score >= MIN_SCORE);
        // Nunca ruta crítica: un callback roto no tumba la búsqueda.
        try {
          onResults?.(results);
        } catch {
          /* noop */
        }
        return { results };
      } catch (e: any) {
        return { error: "transient" as const, message: String(e?.message ?? e) };
      }
    },
  });
}
