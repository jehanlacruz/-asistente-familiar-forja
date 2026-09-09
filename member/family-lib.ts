// member/family-lib.ts — helpers para las tools de familia (member/family-tools.ts).
// Vive en member/, así que forjabot update NUNCA la toca.
import { Db } from "../src/db/client";
import type { Env } from "../src/env";

export interface FamilyMember {
  id: string;
  name: string;
  role: string;
  access_level: "full" | "managed";
  telegram_chat_id: string | null;
  birthdate: string | null;
  weight_kg: number | null;
  height_cm: number | null;
  clothing_size: string | null;
  nationality: string | null;
  food_preferences: string | null;
  created_at: number;
  updated_at: number;
}

/** Conversación → channel_user_id real de quien está escribiendo ahorita. */
export async function getSenderChannelUserId(
  db: Db,
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId) return null;
  const conv = await db.first<{ channel_user_id: string }>(
    "SELECT channel_user_id FROM conversations WHERE id = ?",
    [conversationId],
  );
  return conv?.channel_user_id ?? null;
}

export async function findMemberByChatId(
  db: Db,
  chatId: string,
): Promise<FamilyMember | null> {
  return db.first<FamilyMember>(
    "SELECT * FROM family_members WHERE telegram_chat_id = ?",
    [chatId],
  );
}

/**
 * Busca por nombre exacto primero; si no hay match, cae a "contiene" en
 * cualquier dirección (ej. "Jehan" encuentra a "Jehan Franco La Cruz
 * Barrera" y viceversa) — evita que el bot cree un duplicado por escribir
 * el nombre completo en vez del apodo ya registrado, o al revés.
 */
export async function findMemberByName(db: Db, name: string): Promise<FamilyMember | null> {
  const exact = await db.first<FamilyMember>(
    "SELECT * FROM family_members WHERE lower(name) = lower(?)",
    [name],
  );
  if (exact) return exact;
  const firstWord = name.trim().split(/\s+/)[0] ?? name;
  return db.first<FamilyMember>(
    "SELECT * FROM family_members WHERE lower(name) LIKE lower(?) OR lower(?) LIKE lower('%' || name || '%') LIMIT 1",
    [`%${firstWord}%`, name],
  );
}

export async function listMembers(db: Db): Promise<FamilyMember[]> {
  return db.all<FamilyMember>("SELECT * FROM family_members ORDER BY created_at ASC");
}

export async function countMembers(db: Db): Promise<number> {
  const row = await db.first<{ n: number }>("SELECT COUNT(*) as n FROM family_members");
  return row?.n ?? 0;
}

/** Edad en años a partir de "YYYY-MM-DD". null si no hay fecha o es inválida. */
export function ageFromBirthdate(birthdate: string | null): number | null {
  if (!birthdate) return null;
  const d = new Date(birthdate);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

/** IMC + categoría orientativa (adulto). null si faltan peso/estatura. */
export function bmiInfo(
  weightKg: number | null,
  heightCm: number | null,
): { bmi: number; category: string } | null {
  if (!weightKg || !heightCm) return null;
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  let category: string;
  if (bmi < 18.5) category = "bajo peso";
  else if (bmi < 25) category = "peso saludable";
  else if (bmi < 30) category = "sobrepeso";
  else category = "obesidad";
  return { bmi: Math.round(bmi * 10) / 10, category };
}

/** Trae el username público del bot (para armar el link t.me/<username>). */
export async function getBotUsername(env: Env): Promise<string | null> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  if (!res.ok) return null;
  const json: any = await res.json();
  return json?.result?.username ?? null;
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Fecha de hoy "YYYY-MM-DD" en la zona horaria del bot. */
export function todayInTZ(env: Env): string {
  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  return new Date().toLocaleDateString("sv-SE", { timeZone: tz }); // sv-SE = ISO YYYY-MM-DD
}

/** "YYYY-MM-DD" del timestamp (ms) en la zona horaria del bot. */
export function dateInTZ(ms: number, env: Env): string {
  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  return new Date(ms).toLocaleDateString("sv-SE", { timeZone: tz });
}

export interface Chore {
  id: string;
  title: string;
  assigned_to: string | null;
  status: string;
  due_date: string | null;
  kind: string;
  category: string;
  created_at: number;
  updated_at: number;
}

/** Una tarea 'diaria' marcada hecha en un día anterior vuelve a contar como pendiente hoy. */
export function isChorePending(c: Chore, env: Env, today: string): boolean {
  if (c.status === "pending") return true;
  if (c.kind === "diaria" && c.status === "done") return dateInTZ(c.updated_at, env) !== today;
  return false;
}

export const db = (env: Env) => new Db(env.DB);
