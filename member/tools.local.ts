// member/tools.local.ts — TUS funciones extra del bot ("tools").
//
// Esta carpeta (member/) es TUYA: las actualizaciones (`forjabot update`) NUNCA
// la tocan. Todo lo que definas aquí SOBREVIVE cada actualización, ya conectado
// (a diferencia de editar src/, que el update reemplaza).
//
// Devuelve un objeto { nombreDeLaTool: tool(...) }. Déjalo vacío ({}) para no
// agregar ninguna. Para escribir una sin programar, usa el skill /agregar-tool.
//
// Para agregar una tool, importa los helpers y regrésala:
//   import { tool } from "ai";
//   import { z } from "zod";
//
// `ctx.env` = variables/bindings del bot; `ctx.getConversationId()` = la
// conversación en curso.
import type { MemberToolCtx } from "../src/tools/member";
import { familyTools } from "./family-tools";

export function memberTools(ctx: MemberToolCtx): Record<string, unknown> {
  return {
    ...familyTools(ctx),
  };
}
