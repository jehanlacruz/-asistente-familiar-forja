// member/config.local.ts — generado por `forja init`. Edítalo cuando quieras.
// NUNCA se sobrescribe al actualizar el bot.

export const memberConfig = {
  businessName: "Asistente Familia",
  botName: "Asistente Familia",
  language: "es" as "es" | "en" | "pt",
  tier: "free" as "free" | "pro",
  timezone: "Europe/Berlin",
  // Moneda con la que el bot habla de precios ($ | € | R$). El bot la lee de
  // aquí si no la cambiaste en el panel (setting bot_currency manda si existe).
  currency: "€",
  contactEmail: "jehanlacruz@gmail.com",
};
export type MemberConfig = typeof memberConfig;

export const businessConfig = {
  hours: "",
  services: [] as { name: string; price: number }[],
  location: "Hamburgo, Alemania",
  paymentMethods: [] as string[],
  contactPhone: "",
  customFields: {
  "queHacemos": "gestión de tareas y vida diaria del hogar",
  "ofrecemos": "crear y asignar tareas del hogar con recordatorios, lista de la compra compartida, consultar pendientes del día; próximamente calendario y finanzas familiares",
  "tono": "cercano y amigable, como hablarle a un conocido",
  "preguntasFrecuentes": "apunta leche y huevos, ponme una tarea para mañana, qué tengo que hacer hoy, marca esto como hecho",
  "reglasYEscalacion": "cada miembro del hogar tiene su propia identidad y datos privados dentro del hogar; nunca mezclar datos entre hogares distintos; tono natural y conversacional, no formal de empresa"
} as Record<string, string>,
};

import type { CommentFunnel } from "../src/channels/comment-funnel";
export const commentFunnels: CommentFunnel[] = [];

export const catalog: { name: string; price: number; description?: string; sku?: string }[] = [];
