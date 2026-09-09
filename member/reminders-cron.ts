// member/reminders-cron.ts — revisa recordatorios vencidos y los manda por
// Telegram. Vive en member/, así que forjabot update NUNCA la toca. Se
// invoca desde src/index.ts scheduled() en el tick */5 min (ver wrangler.toml).
import { db, newId, listMembers, sendTelegramMessage, zonedDateTimeToUtcMs, type FamilyMember, type Reminder } from "./family-lib";
import type { Env } from "../src/env";

function localPartsFromMs(ms: number, env: Env) {
  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour"), mm: get("minute") };
}

/** Próxima ocurrencia de un recordatorio repetitivo, en la misma hora local. */
export function nextOccurrenceMs(remindAtMs: number, repeat: string, env: Env): number {
  const { y, m, d, hh, mm } = localPartsFromMs(remindAtMs, env);
  let addDays = 0;
  let addMonths = 0;
  if (repeat === "diario") addDays = 1;
  else if (repeat === "semanal") addDays = 7;
  else if (repeat === "mensual") addMonths = 1;
  const dt = new Date(Date.UTC(y, m - 1 + addMonths, d + addDays));
  const dateStr = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  return zonedDateTimeToUtcMs(dateStr, timeStr, env);
}

export async function runDueReminders(env: Env): Promise<void> {
  const d = db(env);
  const now = Date.now();
  const due = await d.all<Reminder>(
    "SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at ASC LIMIT 25",
    [now],
  );
  if (!due.length) return;

  const members = await listMembers(d);
  const memberById = new Map(members.map((m) => [m.id, m]));

  for (const r of due) {
    // Claim atómico por si dos ticks se solaparan — solo el primero manda.
    const claim = await d.run("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'pending'", [now, r.id]);
    if ((claim.meta?.changes ?? 0) === 0) continue;

    const targets: FamilyMember[] = r.target_member
      ? [memberById.get(r.target_member)].filter((m): m is FamilyMember => !!m?.telegram_chat_id)
      : members.filter((m) => m.access_level === "full" && m.telegram_chat_id);

    for (const m of targets) {
      await sendTelegramMessage(env, m.telegram_chat_id!, `⏰ Recordatorio: ${r.title}`).catch((e) =>
        console.error("[recordatorios] envío falló:", e),
      );
    }

    if (r.repeat) {
      const nextAt = nextOccurrenceMs(r.remind_at, r.repeat, env);
      await d.run(
        `INSERT INTO reminders (id, title, remind_at, target_member, repeat, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [newId(), r.title, nextAt, r.target_member, r.repeat, r.created_by, now],
      );
    }
  }
}
