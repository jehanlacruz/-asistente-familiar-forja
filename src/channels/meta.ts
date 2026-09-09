// Canal OFICIAL de Meta (sin ManyChat): Facebook Messenger + Instagram DMs.
//
// Una sola app de Meta cubre ambos. El webhook (Messenger e Instagram) trae el
// MISMO formato — entry[].messaging[] con sender/message — así que este único
// adaptador sirve para los dos. El envío es la Send API de Meta
// (graph.facebook.com/.../me/messages) con el Page Access Token.
//
// El webhook necesita 2 cosas que ManyChat ocultaba:
//  • GET de verificación (handshake con META_VERIFY_TOKEN) — lo maneja index.ts.
//  • Validar la firma X-Hub-Signature-256 de cada POST — verifyMetaSignature().
import type { ChannelAdapter, IncomingMessage, OutgoingReply, ChannelId, SendOptions } from "./shared";
import { reportSendFailure } from "./shared";
import type { Env } from "../env";

const GRAPH_VERSION = "v21.0";

interface MetaMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    attachments?: { type: string; payload?: { url?: string } }[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: { id?: string; time?: number; messaging?: MetaMessaging[] }[];
}

/**
 * Convierte un webhook de Meta en 0..N mensajes entrantes. Un solo POST puede
 * traer varias entradas y varios eventos; también trae echoes (mensajes que la
 * propia página envió) y recibos de entrega/lectura, que se ignoran.
 */
export function parseMetaEvents(body: MetaWebhookBody): IncomingMessage[] {
  const channel: ChannelId = body.object === "instagram" ? "instagram" : "messenger";
  const out: IncomingMessage[] = [];
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      console.log("meta in:", JSON.stringify({ ch: channel, sender: ev.sender?.id, recipient: ev.recipient?.id, echo: m?.is_echo, text: m?.text?.slice(0, 24) }));
      if (!m || m.is_echo) continue; // ignora echoes
      // Taps de quick replies: los del EMBUDO (payload HZN_FUNNEL:…) los maneja
      // comment-funnel, no el LLM. Los del AGENTE (botones opt-in, payload
      // "btn:…") siguen de largo: el texto del chip ya viene en m.text y el
      // cerebro lo procesa como mensaje normal.
      if (m.quick_reply && (m.quick_reply.payload ?? "").startsWith("HZN_FUNNEL:")) continue;
      const sender = ev.sender?.id;
      if (!sender) continue;
      const audio = m.attachments?.find((a) => a.type === "audio");
      const image = m.attachments?.find((a) => a.type === "image");
      // Adjunto tipo "file": el bot no lo lee, pero se archiva y escala.
      const file = m.attachments?.find((a) => a.type === "file");
      if (!m.text && !audio && !image && !file) continue; // ignora recibos/postbacks sin contenido
      out.push({
        channel,
        channelUserId: String(sender),
        text: m.text || undefined,
        audioUrl: audio?.payload?.url,
        imageUrl: image?.payload?.url,
        fileUrl: file?.payload?.url,
        isOwnerMessage: false,
        receivedAt: Date.now(),
        rawPayload: ev,
        providerMessageId: m.mid,
      });
    }
  }
  return out;
}

/**
 * Valida la firma HMAC-SHA256 (`X-Hub-Signature-256: sha256=<hex>`) que Meta
 * pone en cada POST, usando el App Secret. Comparación en tiempo constante.
 * Fail-closed: sin firma válida o sin secret → false.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// El token de Instagram Login resuelve `me` al "app-scoped id", que NO es el
// dueño del hilo de mensajes — ese es el `user_id` (el Instagram Business
// Account ID). Enviar como `me` da error "not the thread owner" (subcode
// 2534037). Resolvemos el user_id una vez y lo cacheamos por token.
let igSenderIdCache: { token: string; id: string } | null = null;
async function instagramSenderId(token: string): Promise<string> {
  if (igSenderIdCache?.token === token) return igSenderIdCache.id;
  try {
    const r = await fetch(
      `https://graph.instagram.com/${GRAPH_VERSION}/me?fields=user_id&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as { user_id?: string | number };
    const id = j?.user_id ? String(j.user_id) : "me";
    igSenderIdCache = { token, id };
    return id;
  } catch {
    return "me";
  }
}

export const metaAdapter: ChannelAdapter = {
  // Existe por la interfaz ChannelAdapter; el webhook /webhooks/meta usa
  // parseMetaEvents directamente (un POST puede traer varios mensajes).
  async parseIncoming(request: Request, _env: Env): Promise<IncomingMessage> {
    const body = (await request.json()) as MetaWebhookBody;
    const [first] = parseMetaEvents(body);
    if (!first) throw new Error("meta webhook sin mensaje procesable");
    return first;
  },

  async sendReply(reply: OutgoingReply, env: Env, opts?: SendOptions): Promise<void> {
    // Dos rutas de envío según cómo se conectó Instagram:
    //  • "Instagram API con Instagram Login" (token IGAA…) → graph.instagram.com
    //    + INSTAGRAM_ACCESS_TOKEN. (Es lo que Santi usa con @automatizaloia.)
    //  • Messenger / IG ligado a una Página de Facebook → graph.facebook.com
    //    + META_PAGE_ACCESS_TOKEN.
    const useIG = reply.channel === "instagram" && !!env.INSTAGRAM_ACCESS_TOKEN;
    const base = useIG ? "https://graph.instagram.com" : "https://graph.facebook.com";
    const token = useIG ? env.INSTAGRAM_ACCESS_TOKEN : env.META_PAGE_ACCESS_TOKEN;
    if (!token) {
      throw new Error("Meta: falta INSTAGRAM_ACCESS_TOKEN (IG Login) o META_PAGE_ACCESS_TOKEN (Messenger).");
    }
    // Messenger envía como `me` (la Página). Instagram Login debe enviar como el
    // user_id (dueño del hilo), no como `me` (app-scoped id) → si no, 2534037.
    const node = useIG ? await instagramSenderId(token) : "me";
    const url = `${base}/${GRAPH_VERSION}/${node}/messages`;
    console.log("meta out:", JSON.stringify({ useIG, node, to: reply.channelUserId }));
    for (let i = 0; i < reply.chunks.length; i++) {
      const delay = i === 0 ? 0 : reply.interChunkDelayMs ?? 1000;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const mensaje: Record<string, unknown> = { text: reply.chunks[i] };
      // Botones (opt-in): quick replies en el ÚLTIMO chunk. El tap regresa con
      // el título como texto (payload "btn:…" para no chocar con el embudo).
      if (reply.buttons?.length && i === reply.chunks.length - 1) {
        mensaje.quick_replies = reply.buttons.map((b) => ({
          content_type: "text",
          title: b.title,
          payload: b.payload,
        }));
      }
      const payload: Record<string, unknown> = {
        recipient: { id: reply.channelUserId },
        message: mensaje,
      };
      if (!useIG) payload.messaging_type = "RESPONSE"; // requerido en Messenger, no en IG Login
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
      // Meta responde 200 con el message_id o un error JSON. No lo tragues: si
      // falla, logéalo con el cuerpo para ver el motivo exacto (permiso, ventana
      // de 24h, recipiente inválido, etc.). En strict además lanza.
      if (!res.ok) await reportSendFailure(`meta sendReply ${useIG ? "IG" : "FB"}`, res, opts);
    }
    // Galería: cada archivo va como mensaje propio DESPUÉS del texto — en la
    // Send API el attachment es EXCLUYENTE con text, por eso mensaje aparte.
    for (const m of reply.media ?? []) {
      // La Send API no soporta caption en attachments (attachment XOR text) →
      // el caption va como mensaje de texto justo ANTES del archivo.
      // Audio ogg (voice=true) en Instagram: IG no reproduce ogg y lo tira en
      // silencio → mejor el link directo, que sí llega.
      const oggEnIG = m.kind === "audio" && m.voice && reply.channel === "instagram";
      // Instagram no acepta attachments tipo "file" (solo Messenger) → link.
      const archivoEnIG = m.kind === "file" && reply.channel === "instagram";
      const envios: Record<string, unknown>[] = [];
      if (m.caption) envios.push({ text: m.caption });
      envios.push(
        oggEnIG || archivoEnIG
          ? { text: m.filename ? `${m.filename}\n${m.url}` : m.url }
          : { attachment: { type: m.kind, payload: { url: m.url, is_reusable: true } } },
      );
      for (const mensaje of envios) {
        const payload: Record<string, unknown> = {
          recipient: { id: reply.channelUserId },
          message: mensaje,
        };
        if (!useIG) payload.messaging_type = "RESPONSE";
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) await reportSendFailure(`meta media send ${useIG ? "IG" : "FB"}`, res, opts);
      }
    }
  },
};
