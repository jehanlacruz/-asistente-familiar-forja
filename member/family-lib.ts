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
  allergies: string | null;
  nutrition_goal: string | null;
  fitness_level: string | null;
  time_available: string | null;
  injuries: string | null;
  exercise_setting: string | null;
  interests: string | null;
  permission_tier: "admin" | "adult" | null;
  health_private: number;
  created_at: number;
  updated_at: number;
}

/** null (Basic Auth con la contraseña maestra) cuenta como admin — es el rescate. */
export function isAdminViewer(viewer: FamilyMember | null): boolean {
  return viewer === null || viewer.permission_tier === "admin";
}

/** viewer=null vía Basic Auth se trata como admin (ver isAdminViewer); sin identificar por chat, sin privilegios. */
export function canSeeHealthOf(m: FamilyMember, viewer: FamilyMember | null): boolean {
  if (!m.health_private) return true;
  return isAdminViewer(viewer) || viewer?.id === m.id;
}

export interface Transaction {
  id: string;
  type: "ingreso" | "gasto";
  amount: number;
  category: string;
  description: string | null;
  member_id: string | null;
  fund_id: string | null;
  visibility: "compartido" | "privado";
  date: string;
  created_at: number;
  updated_at: number;
}

export interface Budget {
  category: string;
  monthly_limit: number;
  updated_at: number;
}

export interface FinanceFund {
  id: string;
  name: string;
  kind: "porcentaje" | "fijo" | "ahorro";
  percentage: number | null;
  monthly_target: number | null;
  notes: string | null;
  is_subscription: number;
  created_at: number;
  updated_at: number;
}

export interface FamilyActivity {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  for_member: string | null;
  is_favorite: number;
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

export interface Reminder {
  id: string;
  title: string;
  remind_at: number;
  target_member: string | null;
  repeat: string | null;
  status: string;
  created_by: string | null;
  created_at: number;
  sent_at: number | null;
}

/**
 * Convierte una fecha+hora "de pared" en la zona horaria del bot (ej.
 * "2026-09-10" + "08:30" en Europe/Berlin) al epoch UTC en ms — sin
 * librerías, con el truco estándar de comparar cómo se ve ese instante
 * ya formateado de vuelta en esa zona horaria (correcto también en DST).
 */
export function zonedDateTimeToUtcMs(dateStr: string, timeStr: string, env: Env): number {
  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const guessUtc = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(guessUtc));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asIfLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return guessUtc - (asIfLocal - guessUtc);
}

/** "10/09/2026, 08:30" en la zona horaria del bot, para mostrar al humano. */
export function formatDateTimeInTZ(ms: number, env: Env): string {
  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  return new Date(ms).toLocaleString("es-ES", { timeZone: tz, dateStyle: "short", timeStyle: "short" });
}

/** Manda un mensaje de texto simple por Telegram (fuera del flujo del agente — usado por el cron de recordatorios). */
export async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<boolean> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return res.ok;
}

/** Balance actual de un sobre: lo asignado (fund_allocations) menos lo gastado con ese fund_id. */
export async function fundBalance(d: Db, fundId: string): Promise<number> {
  const alloc = await d.first<{ total: number }>("SELECT COALESCE(SUM(amount), 0) as total FROM fund_allocations WHERE fund_id = ?", [fundId]);
  const spent = await d.first<{ total: number }>(
    "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'gasto' AND fund_id = ?",
    [fundId],
  );
  return (alloc?.total ?? 0) - (spent?.total ?? 0);
}

/** Reparte un ingreso entre los sobres definidos: % primero, luego fijos hasta su meta del mes, el resto a ahorro. */
export async function allocateIncomeToFunds(
  d: Db,
  transactionId: string,
  amount: number,
  date: string,
): Promise<{ fondo: string; monto: number }[]> {
  const month = date.slice(0, 7);
  const funds = await d.all<FinanceFund>("SELECT * FROM finance_funds ORDER BY created_at ASC");
  if (!funds.length) return [];
  const now = Date.now();
  const breakdown: { fondo: string; monto: number }[] = [];
  let remaining = amount;

  const insertAlloc = async (fundId: string, amt: number) => {
    if (amt <= 0) return;
    await d.run(
      `INSERT INTO fund_allocations (id, fund_id, transaction_id, amount, date, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [newId(), fundId, transactionId, amt, date, now],
    );
  };

  for (const f of funds.filter((f) => f.kind === "porcentaje" && f.percentage)) {
    const amt = Math.round(amount * (f.percentage! / 100) * 100) / 100;
    await insertAlloc(f.id, amt);
    breakdown.push({ fondo: f.name, monto: amt });
    remaining -= amt;
  }

  for (const f of funds.filter((f) => f.kind === "fijo" && f.monthly_target)) {
    const already = await d.first<{ total: number }>(
      "SELECT COALESCE(SUM(amount), 0) as total FROM fund_allocations WHERE fund_id = ? AND substr(date, 1, 7) = ?",
      [f.id, month],
    );
    const shortfall = Math.max(0, f.monthly_target! - (already?.total ?? 0));
    const amt = Math.min(shortfall, Math.max(0, remaining));
    await insertAlloc(f.id, amt);
    if (amt > 0) breakdown.push({ fondo: f.name, monto: amt });
    remaining -= amt;
  }

  const ahorroFunds = funds.filter((f) => f.kind === "ahorro");
  if (ahorroFunds.length && remaining > 0) {
    const each = Math.round((remaining / ahorroFunds.length) * 100) / 100;
    for (const f of ahorroFunds) {
      await insertAlloc(f.id, each);
      breakdown.push({ fondo: f.name, monto: each });
    }
    remaining = 0;
  }

  if (remaining > 0.01) breakdown.push({ fondo: "Sin asignar", monto: Math.round(remaining * 100) / 100 });
  return breakdown;
}

/** Caducidad de enlaces de invitación (Telegram y web) y cupo de accesos completos por hogar. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FULL_ACCESS = 5;

export interface Debt {
  id: string;
  name: string;
  balance: number;
  annual_rate: number | null;
  monthly_payment: number;
  created_at: number;
  updated_at: number;
}

/**
 * Meses para liquidar un saldo con un pago mensual fijo, y el interés total
 * que se paga en el camino — fórmula estándar de amortización. null si el
 * pago no alcanza ni a cubrir el interés del mes (nunca se paga así).
 */
export function loanPayoff(balance: number, annualRatePct: number | null, monthlyPayment: number): { months: number; totalInterest: number; totalPaid: number } | null {
  if (balance <= 0) return { months: 0, totalInterest: 0, totalPaid: 0 };
  const r = (annualRatePct ?? 0) / 100 / 12;
  if (r === 0) {
    if (monthlyPayment <= 0) return null;
    const months = Math.ceil(balance / monthlyPayment);
    return { months, totalInterest: 0, totalPaid: balance };
  }
  if (monthlyPayment <= balance * r) return null;
  const months = Math.ceil(-Math.log(1 - (balance * r) / monthlyPayment) / Math.log(1 + r));
  const totalPaid = months * monthlyPayment;
  return { months, totalInterest: Math.round((totalPaid - balance) * 100) / 100, totalPaid: Math.round(totalPaid * 100) / 100 };
}

export const db = (env: Env) => new Db(env.DB);
