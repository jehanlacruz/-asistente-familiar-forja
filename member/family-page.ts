// member/family-page.ts — "Centro Familiar" web app de la familia La Cruz
// ("/familia"). Vive en member/, así que forjabot update NUNCA la toca. Se
// monta desde src/index.ts (rutas finas, ver ese archivo) porque una ruta
// HTTP nueva no tiene otro punto de extensión — protegida con el mismo
// Basic Auth del panel.
//
// Estructura: pantalla de inicio con una tarjeta por área → cada tarjeta
// abre su propia página con el detalle completo (ver/editar/crear/borrar).
// Áreas ya construidas: Integrantes, Tareas (+ejercicio), Compra, Menú.
// Áreas "próximamente" (placeholders con lo que van a hacer): Recordatorios
// reales, Actividad física con plan, Niños y actividades, Finanzas.
import {
  db,
  newId,
  listMembers,
  findMemberByName,
  ageFromBirthdate,
  bmiInfo,
  todayInTZ,
  isChorePending,
  zonedDateTimeToUtcMs,
  formatDateTimeInTZ,
  fundBalance,
  isAdminViewer,
  canSeeHealthOf,
  allocateIncomeToFunds,
  loanPayoff,
  INVITE_TTL_MS,
  MAX_FULL_ACCESS,
  ACHIEVEMENT_CATALOG,
  starBalance,
  type FamilyMember,
  type Chore,
  type Reminder,
  type FamilyActivity,
  type Transaction,
  type Debt,
  type Budget,
  type FinanceFund,
  type StarActivity,
  type Reward,
  type RewardRedemption,
  type AchievementEarned,
} from "./family-lib";
import type { Env } from "../src/env";
import { ICON_192_BASE64, ICON_512_BASE64 } from "./pwa-assets";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── PWA: instalable en el teléfono/escritorio ──────────────────────────
//
// Alcance real (no prometer de más): instalar funciona en Android/Chrome y
// escritorio de forma nativa; en iPhone requiere que la familia use el botón
// "Compartir → Agregar a inicio" de Safari (Apple no permite instalar solo
// con visitar la página). El service worker de abajo cachea la ÚLTIMA
// pantalla vista para que no quede en blanco sin conexión — no permite crear
// ni editar datos sin internet (todo pasa por D1, no hay guardado offline
// real), y no hay notificaciones push todavía.

export function buildManifest(env: Env): string {
  return JSON.stringify({
    name: env.BUSINESS_NAME || "Centro Familiar",
    short_name: "Familia",
    description: "Organiza tareas, comidas, ejercicio, compras, recordatorios y finanzas de la familia.",
    start_url: "/familia",
    scope: "/familia/",
    display: "standalone",
    background_color: "#f3f4f8",
    theme_color: "#2b6e63",
    lang: "es",
    icons: [
      { src: "/familia/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/familia/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });
}

export function buildServiceWorker(): string {
  return `const CACHE = "centro-familiar-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { self.clients.claim(); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((cached) => cached || new Response("Sin conexión.", { status: 503 })))
  );
});`;
}

export function decodeIcon(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export { ICON_192_BASE64, ICON_512_BASE64 };

// ── Acciones (llamadas desde las rutas en src/index.ts) ───────────────────

export async function toggleChore(env: Env, id: string): Promise<void> {
  const d = db(env);
  const chore = await d.first<Chore>(
    "SELECT id, title, assigned_to, status, due_date, kind, category, created_at, updated_at FROM household_chores WHERE id = ?",
    [id],
  );
  if (!chore) return;
  const pending = isChorePending(chore, env, todayInTZ(env));
  await d.run("UPDATE household_chores SET status = ?, updated_at = ? WHERE id = ?", [
    pending ? "done" : "pending",
    Date.now(),
    id,
  ]);
}

export async function toggleShoppingItem(env: Env, id: string): Promise<void> {
  const d = db(env);
  const item = await d.first<{ status: string }>("SELECT status FROM shopping_items WHERE id = ?", [id]);
  if (!item) return;
  await d.run("UPDATE shopping_items SET status = ?, updated_at = ? WHERE id = ?", [
    item.status === "pending" ? "bought" : "pending",
    Date.now(),
    id,
  ]);
}

export async function deleteChore(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM household_chores WHERE id = ?", [id]);
}

export async function deleteShoppingItem(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM shopping_items WHERE id = ?", [id]);
}

export async function addChoreFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const titulo = (form.titulo || "").trim();
  if (!titulo) return;
  const d = db(env);
  let assignedId: string | null = null;
  if (form.asignado) {
    const m = await findMemberByName(d, form.asignado);
    assignedId = m?.id ?? null;
  }
  const now = Date.now();
  await d.run(
    `INSERT INTO household_chores (id, title, assigned_to, status, due_date, kind, category, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [newId(), titulo, assignedId, form.fecha || null, form.kind === "diaria" ? "diaria" : "puntual", form.category === "ejercicio" ? "ejercicio" : "tarea", now, now],
  );
}

export async function addShoppingItemFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const nombre = (form.nombre || "").trim();
  if (!nombre) return;
  const d = db(env);
  const now = Date.now();
  await d.run(
    `INSERT INTO shopping_items (id, name, category, quantity, status, added_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    [newId(), nombre, form.categoria || null, form.cantidad || null, now, now],
  );
}

export async function addMemberFromForm(
  env: Env,
  form: Record<string, string>,
  viewer: FamilyMember | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const nombre = (form.nombre || "").trim();
  if (!nombre) return { ok: false, error: "Falta el nombre." };
  const d = db(env);
  const now = Date.now();
  const wantsFull = form.acceso === "full";
  if (wantsFull) {
    if (!isAdminViewer(viewer)) return { ok: false, error: "Solo un administrador del hogar puede dar de alta acceso completo." };
    const fullCount = await d.first<{ n: number }>("SELECT COUNT(*) as n FROM family_members WHERE access_level = 'full'");
    if ((fullCount?.n ?? 0) >= MAX_FULL_ACCESS) {
      return { ok: false, error: `Ya hay ${MAX_FULL_ACCESS} integrantes con acceso completo — es el máximo por hogar. Registra a ${nombre} sin acceso completo, o quita el acceso a otro integrante primero.` };
    }
  }
  await d.run(
    `INSERT INTO family_members
      (id, name, role, access_level, permission_tier, birthdate, weight_kg, height_cm, clothing_size, nationality, food_preferences, allergies, nutrition_goal, fitness_level, time_available, injuries, exercise_setting, interests, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      nombre,
      form.rol || "",
      wantsFull ? "full" : "managed",
      wantsFull ? "adult" : null,
      form.fechaNacimiento || null,
      form.pesoKg ? Number(form.pesoKg) : null,
      form.estaturaCm ? Number(form.estaturaCm) : null,
      form.tallaRopa || null,
      form.nacionalidad || null,
      form.preferenciasComida || null,
      form.alergias || null,
      form.objetivoNutricional || null,
      form.nivelFisico || null,
      form.tiempoDisponible || null,
      form.lesiones || null,
      form.dondeEjercicio || null,
      form.intereses || null,
      now,
      now,
    ],
  );
  return { ok: true };
}

export async function updateMemberFromForm(
  env: Env,
  id: string,
  form: Record<string, string>,
  viewer: FamilyMember | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = db(env);
  const current = await d.first<FamilyMember>("SELECT * FROM family_members WHERE id = ?", [id]);
  if (!current) return { ok: false, error: "No encontré a ese integrante." };

  const wantsFull = form.acceso === "full";
  const admin = isAdminViewer(viewer);

  if (wantsFull && current.access_level !== "full") {
    if (!admin) return { ok: false, error: "Solo un administrador del hogar puede dar acceso completo." };
    const fullCount = await d.first<{ n: number }>("SELECT COUNT(*) as n FROM family_members WHERE access_level = 'full'");
    if ((fullCount?.n ?? 0) >= MAX_FULL_ACCESS) {
      return { ok: false, error: `Ya hay ${MAX_FULL_ACCESS} integrantes con acceso completo — es el máximo por hogar.` };
    }
  }

  let permissionTier: string | null = wantsFull ? (current.permission_tier ?? "adult") : null;
  if (wantsFull && form.nivelPermiso && form.nivelPermiso !== current.permission_tier) {
    if (!admin) return { ok: false, error: "Solo un administrador del hogar puede cambiar el nivel de permiso." };
    permissionTier = form.nivelPermiso === "admin" ? "admin" : "adult";
  }

  const healthPrivate = form.datosSaludPrivados === "1" ? 1 : 0;
  if (healthPrivate !== current.health_private && !admin && viewer?.id !== id) {
    return { ok: false, error: "Solo esta persona o un administrador pueden cambiar la privacidad de sus datos de salud." };
  }

  await d.run(
    `UPDATE family_members SET
      name = ?, role = ?, access_level = ?, permission_tier = ?, health_private = ?, birthdate = ?, weight_kg = ?, height_cm = ?,
      clothing_size = ?, nationality = ?, food_preferences = ?, allergies = ?, nutrition_goal = ?,
      fitness_level = ?, time_available = ?, injuries = ?, exercise_setting = ?, interests = ?, updated_at = ?
     WHERE id = ?`,
    [
      (form.nombre || "").trim(),
      form.rol || "",
      wantsFull ? "full" : "managed",
      permissionTier,
      healthPrivate,
      form.fechaNacimiento || null,
      form.pesoKg ? Number(form.pesoKg) : null,
      form.estaturaCm ? Number(form.estaturaCm) : null,
      form.tallaRopa || null,
      form.nacionalidad || null,
      form.preferenciasComida || null,
      form.alergias || null,
      form.objetivoNutricional || null,
      form.nivelFisico || null,
      form.tiempoDisponible || null,
      form.lesiones || null,
      form.dondeEjercicio || null,
      form.intereses || null,
      Date.now(),
      id,
    ],
  );
  return { ok: true };
}

export async function addActivityFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const titulo = (form.titulo || "").trim();
  if (!titulo) return;
  const d = db(env);
  let forId: string | null = null;
  if (form.paraQuien) {
    const m = await findMemberByName(d, form.paraQuien);
    forId = m?.id ?? null;
  }
  const now = Date.now();
  await d.run(
    `INSERT INTO family_activities (id, title, description, kind, for_member, is_favorite, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [newId(), titulo, form.descripcion || null, form.tipo || "casa", forId, now, now],
  );
}

export async function toggleActivityFavorite(env: Env, id: string): Promise<void> {
  const d = db(env);
  const row = await d.first<{ is_favorite: number }>("SELECT is_favorite FROM family_activities WHERE id = ?", [id]);
  if (!row) return;
  await d.run("UPDATE family_activities SET is_favorite = ?, updated_at = ? WHERE id = ?", [row.is_favorite ? 0 : 1, Date.now(), id]);
}

export async function deleteActivity(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM family_activities WHERE id = ?", [id]);
}

export async function addTransactionFromForm(
  env: Env,
  form: Record<string, string>,
  viewer: FamilyMember | null,
): Promise<{ reparto?: { fondo: string; monto: number }[] }> {
  const categoria = (form.categoria || "").trim();
  const monto = Number(form.monto);
  if (!categoria || !monto) return {};
  const d = db(env);
  const now = Date.now();
  const date = form.fecha || todayInTZ(env);
  const tipo = form.tipo === "ingreso" ? "ingreso" : "gasto";
  const txId = newId();
  const visibility = form.privado === "1" ? "privado" : "compartido";

  let fundId: string | null = null;
  if (tipo === "gasto") {
    const fundName = form.fondo || categoria;
    const fund = await d.first<{ id: string }>("SELECT id FROM finance_funds WHERE lower(name) = lower(?)", [fundName]);
    fundId = fund?.id ?? null;
  }

  await d.run(
    `INSERT INTO transactions (id, type, amount, category, description, member_id, fund_id, visibility, date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [txId, tipo, monto, categoria, form.descripcion || null, viewer?.id ?? null, fundId, visibility, date, now, now],
  );

  if (tipo === "ingreso") return { reparto: await allocateIncomeToFunds(d, txId, monto, date) };
  return {};
}

export async function deleteTransaction(env: Env, id: string, viewer: FamilyMember | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = db(env);
  const tx = await d.first<{ visibility: string; member_id: string | null }>("SELECT visibility, member_id FROM transactions WHERE id = ?", [id]);
  if (!tx) return { ok: true }; // ya no existe, nada que hacer
  if (tx.visibility === "privado" && !isAdminViewer(viewer) && tx.member_id !== viewer?.id) {
    return { ok: false, error: "Es una transacción privada de otra persona." };
  }
  await d.run("DELETE FROM transactions WHERE id = ?", [id]);
  return { ok: true };
}

export async function updateTransactionFromForm(
  env: Env,
  id: string,
  form: Record<string, string>,
  viewer: FamilyMember | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = db(env);
  const current = await d.first<Transaction>("SELECT * FROM transactions WHERE id = ?", [id]);
  if (!current) return { ok: false, error: "Esa transacción ya no existe." };
  if (current.visibility === "privado" && !isAdminViewer(viewer) && current.member_id !== viewer?.id) {
    return { ok: false, error: "Es una transacción privada de otra persona." };
  }
  const categoria = (form.categoria || "").trim();
  const monto = Number(form.monto);
  if (!categoria || !monto) return { ok: false, error: "Falta la categoría o el monto." };

  let fundId: string | null = null;
  if (form.tipo === "gasto") {
    const fundName = form.fondo || categoria;
    const fund = await d.first<{ id: string }>("SELECT id FROM finance_funds WHERE lower(name) = lower(?)", [fundName]);
    fundId = fund?.id ?? null;
  }

  await d.run(
    `UPDATE transactions SET type = ?, amount = ?, category = ?, description = ?, fund_id = ?, visibility = ?, date = ?, updated_at = ? WHERE id = ?`,
    [
      form.tipo === "ingreso" ? "ingreso" : "gasto",
      monto,
      categoria,
      form.descripcion || null,
      fundId,
      form.privado === "1" ? "privado" : "compartido",
      form.fecha || current.date,
      Date.now(),
      id,
    ],
  );
  return { ok: true };
}

export function renderEditTransactionPage(env: Env, tx: Transaction, cur: string): string {
  const body = `<section class="panel">
    <h2>✏️ Editar movimiento</h2>
    <form method="post" action="/familia/transaccion/${tx.id}">
      <label class="field">Tipo<select name="tipo"><option value="gasto" ${tx.type === "gasto" ? "selected" : ""}>Gasto</option><option value="ingreso" ${tx.type === "ingreso" ? "selected" : ""}>Ingreso</option></select></label>
      <label class="field">Monto (${esc(cur)})<input type="number" step="0.01" name="monto" value="${tx.amount}" required></label>
      <label class="field">Categoría<input type="text" name="categoria" value="${esc(tx.category)}" required></label>
      <label class="field">Descripción<input type="text" name="descripcion" value="${esc(tx.description ?? "")}"></label>
      <label class="field">Sobre (si aplica)<input type="text" name="fondo" value=""></label>
      <label class="field">Fecha<input type="date" name="fecha" value="${tx.date}"></label>
      <label class="chk"><input type="checkbox" name="privado" value="1" ${tx.visibility === "privado" ? "checked" : ""}> Privado (solo yo y los admins)</label>
      <div class="btn-row">
        <button type="submit">Guardar cambios</button>
        <a class="btn-secondary" href="/familia/finanzas">Cancelar</a>
      </div>
    </form>
  </section>`;
  return layout(env, "Editar movimiento", "finanzas", body);
}

export async function setBudgetFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const categoria = (form.categoria || "").trim();
  const monto = Number(form.montoMensual);
  if (!categoria || !monto) return;
  await db(env).run(
    `INSERT INTO budgets (category, monthly_limit, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = excluded.updated_at`,
    [categoria, monto, Date.now()],
  );
}

export async function setFundFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const nombre = (form.nombre || "").trim();
  const tipo = form.tipo === "fijo" || form.tipo === "ahorro" ? form.tipo : "porcentaje";
  if (!nombre) return;
  const porcentaje = form.porcentaje ? Number(form.porcentaje) : null;
  const montoMensual = form.montoMensual ? Number(form.montoMensual) : null;
  const esSuscripcion = form.esSuscripcion === "1" ? 1 : 0;
  const now = Date.now();
  await db(env).run(
    `INSERT INTO finance_funds (id, name, kind, percentage, monthly_target, notes, is_subscription, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, percentage = excluded.percentage, monthly_target = excluded.monthly_target, is_subscription = excluded.is_subscription, updated_at = excluded.updated_at`,
    [newId(), nombre, tipo, porcentaje, montoMensual, null, esSuscripcion, now, now],
  );
}

export async function deleteFund(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM finance_funds WHERE id = ?", [id]);
}

export async function setDebtFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const nombre = (form.nombre || "").trim();
  const balance = Number(form.saldo);
  const pagoMensual = Number(form.pagoMensual);
  if (!nombre || !balance || !pagoMensual) return;
  const tasa = form.tasaAnual ? Number(form.tasaAnual) : null;
  const now = Date.now();
  const d = db(env);
  const existing = await d.first<{ id: string }>("SELECT id FROM debts WHERE lower(name) = lower(?)", [nombre]);
  if (existing) {
    await d.run("UPDATE debts SET balance = ?, annual_rate = ?, monthly_payment = ?, updated_at = ? WHERE id = ?", [balance, tasa, pagoMensual, now, existing.id]);
  } else {
    await d.run(
      "INSERT INTO debts (id, name, balance, annual_rate, monthly_payment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [newId(), nombre, balance, tasa, pagoMensual, now, now],
    );
  }
}

export async function deleteDebt(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM debts WHERE id = ?", [id]);
}

// ── Estrellas, recompensas y logros ─────────────────────────────────────

export async function giveStarsFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const memberId = form.integranteId || "";
  if (!memberId) return;
  const d = db(env);
  let points: number | null = null;
  let activityId: string | null = null;
  let reason: string | null = null;
  if (form.actividadId) {
    const act = await d.first<StarActivity>("SELECT * FROM star_activities WHERE id = ?", [form.actividadId]);
    if (act) {
      activityId = act.id;
      points = act.points;
      reason = act.name;
    }
  } else if (form.puntos) {
    points = Number(form.puntos);
    reason = form.razon || null;
  }
  if (points == null || Number.isNaN(points) || points === 0) return;
  await d.run(
    "INSERT INTO star_awards (id, member_id, activity_id, reason, points, awarded_by, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    [newId(), memberId, activityId, reason, points, Date.now()],
  );
}

export async function setStarActivityFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const nombre = (form.nombre || "").trim();
  const puntos = Number(form.puntos);
  if (!nombre || !puntos) return;
  const d = db(env);
  const existing = await d.first<{ id: string }>("SELECT id FROM star_activities WHERE lower(name) = lower(?)", [nombre]);
  if (existing) {
    await d.run("UPDATE star_activities SET points = ? WHERE id = ?", [puntos, existing.id]);
  } else {
    await d.run("INSERT INTO star_activities (id, name, points, created_at) VALUES (?, ?, ?, ?)", [newId(), nombre, puntos, Date.now()]);
  }
}

export async function deleteStarActivity(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM star_activities WHERE id = ?", [id]);
}

export async function setRewardFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const nombre = (form.nombre || "").trim();
  const costo = Number(form.costo);
  if (!nombre || !costo) return;
  const d = db(env);
  const existing = await d.first<{ id: string }>("SELECT id FROM rewards WHERE lower(name) = lower(?)", [nombre]);
  if (existing) {
    await d.run("UPDATE rewards SET cost_stars = ? WHERE id = ?", [costo, existing.id]);
  } else {
    await d.run("INSERT INTO rewards (id, name, cost_stars, created_at) VALUES (?, ?, ?, ?)", [newId(), nombre, costo, Date.now()]);
  }
}

export async function deleteReward(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM rewards WHERE id = ?", [id]);
}

export async function requestRedemptionFromForm(env: Env, form: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }> {
  const memberId = form.integranteId || "";
  const rewardId = form.recompensaId || "";
  if (!memberId || !rewardId) return { ok: false, error: "Faltan datos." };
  const d = db(env);
  const reward = await d.first<Reward>("SELECT * FROM rewards WHERE id = ?", [rewardId]);
  if (!reward) return { ok: false, error: "No encontré esa recompensa." };
  const balance = await starBalance(d, memberId);
  if (balance < reward.cost_stars) return { ok: false, error: `Faltan ${reward.cost_stars - balance} ⭐ para "${reward.name}".` };
  await d.run(
    "INSERT INTO reward_redemptions (id, member_id, reward_id, reward_name, cost_stars, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    [newId(), memberId, reward.id, reward.name, reward.cost_stars, Date.now()],
  );
  return { ok: true };
}

export async function resolveRedemption(env: Env, id: string, approve: boolean): Promise<void> {
  const d = db(env);
  const redemption = await d.first<RewardRedemption>("SELECT * FROM reward_redemptions WHERE id = ? AND status = 'pending'", [id]);
  if (!redemption) return;
  const now = Date.now();
  await d.run("UPDATE reward_redemptions SET status = ?, resolved_at = ? WHERE id = ?", [approve ? "approved" : "rejected", now, id]);
  if (approve) {
    await d.run(
      "INSERT INTO star_awards (id, member_id, activity_id, reason, points, awarded_by, created_at) VALUES (?, ?, NULL, ?, ?, NULL, ?)",
      [newId(), redemption.member_id, `Canje: ${redemption.reward_name}`, -redemption.cost_stars, now],
    );
  }
}

export async function giveAchievementFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const memberId = form.integranteId || "";
  const badgeKey = form.logro || "";
  if (!memberId || !ACHIEVEMENT_CATALOG[badgeKey]) return;
  const d = db(env);
  const already = await d.first<{ id: string }>("SELECT id FROM achievements_earned WHERE member_id = ? AND badge_key = ?", [memberId, badgeKey]);
  if (already) return;
  await d.run(
    "INSERT INTO achievements_earned (id, member_id, badge_key, awarded_by, created_at) VALUES (?, ?, ?, NULL, ?)",
    [newId(), memberId, badgeKey, Date.now()],
  );
}

export async function deleteMember(env: Env, id: string): Promise<void> {
  await db(env).run("DELETE FROM family_members WHERE id = ?", [id]);
}

/** Cierra sesiones web y desvincula Telegram de un integrante, sin borrar su perfil. */
export async function revokeMemberAccess(env: Env, id: string): Promise<void> {
  const d = db(env);
  const now = Date.now();
  await d.run("UPDATE family_members SET telegram_chat_id = NULL, updated_at = ? WHERE id = ?", [now, id]);
  await d.run("DELETE FROM family_web_sessions WHERE member_id = ?", [id]);
  await d.run("UPDATE family_invites SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL", [now, id]);
  await d.run("UPDATE family_web_invites SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL", [now, id]);
}

// ── Login individual de la web (family_web_invites → family_web_sessions) ──

export async function createWebInvite(
  env: Env,
  memberId: string,
): Promise<{ ok: true; token: string; memberName: string } | { ok: false; error: string }> {
  const d = db(env);
  const member = await d.first<FamilyMember>("SELECT * FROM family_members WHERE id = ?", [memberId]);
  if (!member) return { ok: false, error: "No encontré a ese integrante." };
  if (member.access_level !== "full")
    return { ok: false, error: `${member.name} no tiene acceso completo — no necesita su propia sesión web.` };
  const token = newId().replace(/-/g, "") + newId().replace(/-/g, "");
  const now = Date.now();
  await d.run("INSERT INTO family_web_invites (token, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [token, memberId, now, now + INVITE_TTL_MS]);
  return { ok: true, token, memberName: member.name };
}

/** Consume el enlace de invitación (un solo uso) y devuelve el token de sesión nuevo, o null si ya no es válido. */
export async function consumeWebInvite(env: Env, inviteToken: string): Promise<string | null> {
  const d = db(env);
  const invite = await d.first<{ member_id: string; used_at: number | null; expires_at: number | null; revoked_at: number | null }>(
    "SELECT member_id, used_at, expires_at, revoked_at FROM family_web_invites WHERE token = ?",
    [inviteToken],
  );
  if (!invite || invite.used_at || invite.revoked_at) return null;
  if (invite.expires_at && invite.expires_at < Date.now()) return null;
  const sessionToken = newId().replace(/-/g, "") + newId().replace(/-/g, "");
  await d.run("INSERT INTO family_web_sessions (token, member_id, created_at) VALUES (?, ?, ?)", [sessionToken, invite.member_id, Date.now()]);
  await d.run("UPDATE family_web_invites SET used_at = ? WHERE token = ?", [Date.now(), inviteToken]);
  return sessionToken;
}

export async function findFamilySessionMember(env: Env, sessionToken: string): Promise<FamilyMember | null> {
  const d = db(env);
  const row = await d.first<{ member_id: string }>("SELECT member_id FROM family_web_sessions WHERE token = ?", [sessionToken]);
  if (!row) return null;
  return d.first<FamilyMember>("SELECT * FROM family_members WHERE id = ? AND access_level = 'full'", [row.member_id]);
}

export async function deleteWebSession(env: Env, sessionToken: string): Promise<void> {
  await db(env).run("DELETE FROM family_web_sessions WHERE token = ?", [sessionToken]);
}

export function renderWebInviteLinkPage(env: Env, memberName: string, url: string): string {
  const body = `<section class="panel" style="text-align:center;">
    <h2>🔗 Enlace de acceso para ${esc(memberName)}</h2>
    <p class="soon-desc">Mándaselo por su Telegram u otro chat privado — es de un solo uso. Al abrirlo en su navegador queda con su propia sesión guardada ahí; no necesita saber ninguna contraseña.</p>
    <div class="invite-link-box">${esc(url)}</div>
    <a class="btn-secondary" href="/familia/integrantes">← Volver</a>
  </section>`;
  return layout(env, "Enlace generado", "integrantes", body);
}

export function renderWebInviteInvalidPage(env: Env): string {
  return layout(
    env,
    "Enlace inválido",
    "integrantes",
    `<section class="panel" style="text-align:center;"><p>Este enlace ya se usó o no es válido. Pide uno nuevo desde <a href="/familia/integrantes">Integrantes</a>.</p></section>`,
  );
}

export async function saveTodayMenuFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const d = db(env);
  const date = todayInTZ(env);
  const existing = await d.first<{ date: string }>("SELECT date FROM meal_plan WHERE date = ?", [date]);
  const now = Date.now();
  if (existing) {
    await d.run("UPDATE meal_plan SET breakfast = ?, lunch = ?, dinner = ?, updated_at = ? WHERE date = ?", [
      form.desayuno || null,
      form.comida || null,
      form.cena || null,
      now,
      date,
    ]);
  } else {
    await d.run(
      "INSERT INTO meal_plan (date, breakfast, lunch, dinner, notes, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
      [date, form.desayuno || null, form.comida || null, form.cena || null, now, now],
    );
  }
}

export async function addReminderFromForm(env: Env, form: Record<string, string>): Promise<void> {
  const titulo = (form.titulo || "").trim();
  if (!titulo || !form.fecha || !form.hora) return;
  const d = db(env);
  let targetId: string | null = null;
  if (form.paraQuien) {
    const m = await findMemberByName(d, form.paraQuien);
    targetId = m?.id ?? null;
  }
  const remindAt = zonedDateTimeToUtcMs(form.fecha, form.hora, env);
  await d.run(
    `INSERT INTO reminders (id, title, remind_at, target_member, repeat, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?)`,
    [newId(), titulo, remindAt, targetId, form.repetir || null, Date.now()],
  );
}

export async function cancelReminder(env: Env, id: string): Promise<void> {
  await db(env).run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", [id]);
}

// ── Layout compartido ──────────────────────────────────────────────────

const NAV = [
  { key: "inicio", href: "/familia", icon: "🏠", label: "Inicio" },
  { key: "integrantes", href: "/familia/integrantes", icon: "👪", label: "Integrantes" },
  { key: "tareas", href: "/familia/tareas", icon: "✅", label: "Tareas" },
  { key: "ejercicio", href: "/familia/ejercicio", icon: "🏃", label: "Ejercicio" },
  { key: "compra", href: "/familia/compra", icon: "🛒", label: "Compra" },
  { key: "menu", href: "/familia/menu", icon: "🍽️", label: "Comida" },
  { key: "recordatorios", href: "/familia/recordatorios", icon: "⏰", label: "Recordatorios" },
  { key: "finanzas", href: "/familia/finanzas", icon: "💶", label: "Finanzas" },
  { key: "creditos", href: "/familia/creditos", icon: "💳", label: "Créditos" },
  { key: "ninos", href: "/familia/ninos", icon: "🧸", label: "Niños" },
  { key: "recompensas", href: "/familia/recompensas", icon: "⭐", label: "Recompensas" },
];

function layout(env: Env, title: string, activeKey: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(env.BUSINESS_NAME || "Centro Familiar")}</title>
<link rel="manifest" href="/familia/manifest.webmanifest">
<meta name="theme-color" content="#2b6e63">
<link rel="apple-touch-icon" href="/familia/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Centro Familiar">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
<style>${SHARED_STYLE}</style>
</head><body>
<header>
  <div class="brand"><span class="brand-badge">👨‍👩‍👧‍👦</span><div><h1>Centro Familiar</h1><p>${esc(env.BUSINESS_NAME || "Familia")}</p></div></div>
</header>
<nav>${NAV.map((n) => `<a href="${n.href}" class="${n.key === activeKey ? "active" : ""}"><span class="nav-ic">${n.icon}</span>${esc(n.label)}</a>`).join("")}</nav>
<main>${bodyHtml}</main>
<footer>Página privada de la familia — no la compartas fuera de casa.<br><form method="post" action="/familia/salir" style="display:inline"><button type="submit" class="link-btn">Cerrar sesión</button></form></footer>
<script>${SHARED_SCRIPT}</script>
<script>if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/familia/sw.js', { scope: '/familia/' }).catch(function(){}); }</script>
</body></html>`;
}

function comingSoonPage(env: Env, key: string, icon: string, title: string, description: string, willHave: string[]): string {
  const body = `<section class="panel soon-panel">
    <div class="soon-icon">${icon}</div>
    <h2>${esc(title)}</h2>
    <p class="soon-desc">${esc(description)}</p>
    <p class="soon-label">Próximamente va a tener:</p>
    <ul class="soon-list">${willHave.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
    <a class="btn-secondary" href="/familia">← Volver al inicio</a>
  </section>`;
  return layout(env, title, key, body);
}

// ── Tarjetas y piezas reusables ────────────────────────────────────────

const GOAL_LABEL: Record<string, string> = {
  bajar_peso: "Bajar de peso",
  mantener: "Mantenerse",
  ganar_musculo: "Ganar músculo",
  comer_mas_sano: "Comer más sano",
  alto_proteina: "Alto en proteína",
  ayuno_intermitente: "Ayuno intermitente",
};

function goalOptions(selected: string | null | undefined): string {
  const opts = [["", "Sin definir"], ...Object.entries(GOAL_LABEL)];
  return opts.map(([v, label]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${esc(label)}</option>`).join("");
}

const FITNESS_LABEL: Record<string, string> = { bajo: "Bajo", medio: "Medio", alto: "Alto" };

function fitnessOptions(selected: string | null | undefined): string {
  const opts = [["", "Nivel físico: sin definir"], ...Object.entries(FITNESS_LABEL)];
  return opts.map(([v, label]) => `<option value="${v}" ${v === (selected || "") ? "selected" : ""}>${esc(label)}</option>`).join("");
}

function memberCard(m: FamilyMember, viewer: FamilyMember | null): string {
  const canSeeHealth = canSeeHealthOf(m, viewer);
  const edad = ageFromBirthdate(m.birthdate);
  const bmi = canSeeHealth ? bmiInfo(m.weight_kg, m.height_cm) : null;
  const rows: string[] = [];
  if (edad != null) rows.push(`<div class="row"><span>Edad</span><b>${edad} año${edad === 1 ? "" : "s"}</b></div>`);
  if (canSeeHealth && m.weight_kg) rows.push(`<div class="row"><span>Peso</span><b>${m.weight_kg} kg</b></div>`);
  if (canSeeHealth && m.height_cm) rows.push(`<div class="row"><span>Estatura</span><b>${m.height_cm} cm</b></div>`);
  if (bmi) rows.push(`<div class="row"><span>IMC</span><b>${bmi.bmi} · ${esc(bmi.category)}</b></div>`);
  if (m.clothing_size) rows.push(`<div class="row"><span>Talla</span><b>${esc(m.clothing_size)}</b></div>`);
  if (m.nationality) rows.push(`<div class="row"><span>Nacionalidad</span><b>${esc(m.nationality)}</b></div>`);
  if (m.food_preferences) rows.push(`<div class="row"><span>Le gusta</span><b>${esc(m.food_preferences)}</b></div>`);
  if (canSeeHealth && m.allergies) rows.push(`<div class="row"><span>Alergias</span><b>${esc(m.allergies)}</b></div>`);
  if (canSeeHealth && m.nutrition_goal) rows.push(`<div class="row"><span>Objetivo</span><b>${esc(GOAL_LABEL[m.nutrition_goal] ?? m.nutrition_goal)}</b></div>`);
  if (canSeeHealth && m.fitness_level) rows.push(`<div class="row"><span>Nivel físico</span><b>${esc(FITNESS_LABEL[m.fitness_level] ?? m.fitness_level)}</b></div>`);
  if (canSeeHealth && m.injuries) rows.push(`<div class="row"><span>Lesiones</span><b>${esc(m.injuries)}</b></div>`);
  if (m.exercise_setting) rows.push(`<div class="row"><span>Dónde entrena</span><b>${esc(m.exercise_setting)}</b></div>`);
  if (m.interests) rows.push(`<div class="row"><span>Intereses</span><b>${esc(m.interests)}</b></div>`);
  if (!canSeeHealth) rows.push(`<div class="empty">🔒 Mantiene sus datos de salud en privado</div>`);
  const badge =
    m.access_level === "full"
      ? m.telegram_chat_id
        ? `<span class="badge ok">conectado</span>`
        : `<span class="badge pending">sin conectar</span>`
      : `<span class="badge managed">perfil gestionado</span>`;
  const isAdmin = isAdminViewer(viewer);
  return `<div class="card">
    <div class="card-head"><h3>${esc(m.name)}</h3>${badge}</div>
    <div class="role">${esc(m.role)}${m.permission_tier === "admin" ? ` · <span class="meta">admin</span>` : ""}</div>
    ${rows.join("") || `<div class="empty">Sin datos todavía</div>`}
    <div class="card-actions">
      <a class="edit-link" href="/familia/integrante/${m.id}/editar">✏️ Editar</a>
      ${isAdmin && m.access_level === "full" ? `<form method="post" action="/familia/integrante/${m.id}/generar-acceso-web"><button type="submit" class="link-btn">🔗 Enlace de acceso web</button></form>` : ""}
    </div>
  </div>`;
}

function choreItem(c: Chore, pending: boolean, assignee: string | null, hideAssignee = false): string {
  const meta = [hideAssignee ? null : assignee, c.due_date].filter(Boolean).join(" · ");
  return `<li class="${pending ? "" : "done"}">
    <label>
      <input type="checkbox" data-toggle="/familia/tarea/${c.id}/toggle" ${pending ? "" : "checked"}>
      <span class="txt">${esc(c.title)}</span>
    </label>
    <span class="row-right">
      ${meta ? `<span class="meta">${esc(meta)}</span>` : ""}
      <button class="del" data-del="/familia/tarea/${c.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;
}

function section(id: string, icon: string, title: string, bodyHtml: string, tone = "green"): string {
  return `<section id="${id}" class="panel">
    <h2><span class="icon-badge tone-${tone}">${icon}</span>${esc(title)}</h2>
    ${bodyHtml}
  </section>`;
}

function assigneeOptions(members: FamilyMember[]): string {
  return members.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("");
}

function addChoreForm(members: FamilyMember[], kind: "diaria" | "puntual", category: "tarea" | "ejercicio"): string {
  return `<form class="add-form" method="post" action="/familia/tarea">
    <input type="hidden" name="kind" value="${kind}">
    <input type="hidden" name="category" value="${category}">
    <input type="text" name="titulo" placeholder="${category === "ejercicio" ? "Nueva rutina…" : "Nueva tarea…"}" required>
    <select name="asignado"><option value="">Sin asignar</option>${assigneeOptions(members)}</select>
    ${kind === "puntual" ? `<input type="date" name="fecha">` : ""}
    <button type="submit">+ Agregar</button>
  </form>`;
}

function groupedChoreList(list: { c: Chore; pending: boolean }[], nameById: Map<string, string>, emptyMsg: string): string {
  if (!list.length) return `<p class="empty-row">${esc(emptyMsg)}</p>`;
  const byMember = new Map<string, { c: Chore; pending: boolean }[]>();
  const unassigned: { c: Chore; pending: boolean }[] = [];
  for (const x of list) {
    if (x.c.assigned_to) {
      if (!byMember.has(x.c.assigned_to)) byMember.set(x.c.assigned_to, []);
      byMember.get(x.c.assigned_to)!.push(x);
    } else {
      unassigned.push(x);
    }
  }
  const blocks = Array.from(byMember.entries())
    .map(([id, items]) => `<div class="assignee-block"><h4>${esc(nameById.get(id) ?? "?")}</h4>${choreList(items, nameById, "", true)}</div>`)
    .join("");
  const unassignedHtml = unassigned.length ? `<div class="assignee-block"><h4>Sin asignar</h4>${choreList(unassigned, nameById, "", true)}</div>` : "";
  return blocks + unassignedHtml;
}

function choreList(list: { c: Chore; pending: boolean }[], nameById: Map<string, string>, emptyMsg: string, hideAssignee = false): string {
  return `<ul class="chores">${
    list.length
      ? list.map((x) => choreItem(x.c, x.pending, x.c.assigned_to ? nameById.get(x.c.assigned_to) ?? null : null, hideAssignee)).join("")
      : `<li class="empty-row">${esc(emptyMsg)}</li>`
  }</ul>`;
}

async function loadChores(env: Env): Promise<{ rows: Chore[]; withPending: { c: Chore; pending: boolean }[]; nameById: Map<string, string> }> {
  const d = db(env);
  const members = await listMembers(d);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const today = todayInTZ(env);
  const rows = await d.all<Chore>(
    "SELECT id, title, assigned_to, status, due_date, kind, category, created_at, updated_at FROM household_chores ORDER BY created_at ASC",
  );
  return { rows, withPending: rows.map((c) => ({ c, pending: isChorePending(c, env, today) })), nameById };
}

// ── Página: Inicio (hub) ───────────────────────────────────────────────

export async function renderHome(env: Env): Promise<string> {
  const { withPending } = await loadChores(env);
  const pendTareas = withPending.filter((x) => x.pending && x.c.category === "tarea");
  const pendEjercicio = withPending.filter((x) => x.pending && x.c.category === "ejercicio");

  const d = db(env);
  const today = todayInTZ(env);
  const menu = await d.first<{ breakfast: string | null; lunch: string | null; dinner: string | null }>(
    "SELECT breakfast, lunch, dinner FROM meal_plan WHERE date = ?",
    [today],
  );
  const shoppingPending = await d.first<{ n: number }>(
    "SELECT COUNT(*) as n FROM shopping_items WHERE status = 'pending'",
  );
  const nextReminder = await d.first<{ title: string; remind_at: number }>(
    "SELECT title, remind_at FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC LIMIT 1",
  );
  const month = today.slice(0, 7);
  const balanceRow = await d.first<{ ingresos: number; gastos: number }>(
    `SELECT
      COALESCE(SUM(CASE WHEN type = 'ingreso' THEN amount ELSE 0 END), 0) as ingresos,
      COALESCE(SUM(CASE WHEN type = 'gasto' THEN amount ELSE 0 END), 0) as gastos
     FROM transactions WHERE substr(date, 1, 7) = ?`,
    [month],
  );
  const cur = await currencySymbol(env);
  const debtsSummary = await d.first<{ n: number; total: number }>(
    "SELECT COUNT(*) as n, COALESCE(SUM(balance), 0) as total FROM debts",
  );
  const starsSummary = await d.first<{ total: number }>("SELECT COALESCE(SUM(points), 0) as total FROM star_awards");
  const pendingRedemptions = await d.first<{ n: number }>("SELECT COUNT(*) as n FROM reward_redemptions WHERE status = 'pending'");

  const menuResumen = menu ? [menu.breakfast, menu.lunch, menu.dinner].filter(Boolean).join(" · ") : null;

  const hubCard = (href: string, icon: string, title: string, body: string, tone: string, soon = false) => `
    <a class="hub-card ${soon ? "soon" : ""}" href="${href}">
      <span class="hub-icon tone-${tone}">${icon}</span>
      <h3>${esc(title)}</h3>
      <p>${body}</p>
      ${soon ? `<span class="soon-tag">próximamente</span>` : ""}
    </a>`;

  const tz = env.BOT_TIMEZONE || "Europe/Berlin";
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const hello = hour < 6 ? "Buenas noches" : hour < 12 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  const dateLabel = new Date().toLocaleDateString("es-ES", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });

  const body = `
    <div class="home-hero">
      <p class="hero-eyebrow">${esc(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1))}</p>
      <h2>${hello}, familia 👋</h2>
    </div>
    <div class="hub-grid">
    ${hubCard("/familia/tareas", "✅", "Tareas de hoy", pendTareas.length ? `${pendTareas.length} pendiente${pendTareas.length === 1 ? "" : "s"}` : "Todo al día 🎉", "green")}
    ${hubCard("/familia/compra", "🛒", "Lista de compras", (shoppingPending?.n ?? 0) > 0 ? `${shoppingPending?.n} por comprar` : "Nada pendiente", "amber")}
    ${hubCard("/familia/menu", "🍽️", "Menú de hoy", esc(menuResumen || "Sin definir todavía"), "rose")}
    ${hubCard("/familia/ejercicio", "🏃", "Ejercicio", pendEjercicio.length ? `${pendEjercicio.length} rutina${pendEjercicio.length === 1 ? "" : "s"} pendiente${pendEjercicio.length === 1 ? "" : "s"}` : "Sin rutinas hoy", "orange")}
    ${hubCard("/familia/recordatorios", "⏰", "Recordatorios", nextReminder ? `${esc(nextReminder.title)} · ${esc(formatDateTimeInTZ(nextReminder.remind_at, env))}` : "Sin recordatorios programados", "red")}
    ${hubCard("/familia/finanzas", "💶", "Finanzas", `Balance del mes: ${((balanceRow?.ingresos ?? 0) - (balanceRow?.gastos ?? 0)).toFixed(2)}${cur}`, "blue")}
    ${hubCard("/familia/creditos", "💳", "Créditos y préstamos", (debtsSummary?.n ?? 0) > 0 ? `${debtsSummary?.n} activo${debtsSummary?.n === 1 ? "" : "s"} · ${(debtsSummary?.total ?? 0).toFixed(2)}${cur}` : "Sin deudas registradas", "cyan")}
    ${hubCard("/familia/ninos", "🧸", "Niños y actividades", "Ideas y favoritas guardadas", "yellow")}
    ${hubCard("/familia/recompensas", "⭐", "Recompensas", (pendingRedemptions?.n ?? 0) > 0 ? `${pendingRedemptions?.n} canje${pendingRedemptions?.n === 1 ? "" : "s"} por aprobar` : `${starsSummary?.total ?? 0} ⭐ en la familia`, "yellow")}
    ${hubCard("/familia/integrantes", "👪", "Integrantes", "Perfiles de la familia", "violet")}
  </div>`;

  return layout(env, "Inicio", "inicio", body);
}

// ── Página: Integrantes ─────────────────────────────────────────────────

export async function renderIntegrantesPage(env: Env, viewer: FamilyMember | null): Promise<string> {
  const members = await listMembers(db(env));
  const body = `<h2 class="page-title"><span class="icon-badge tone-violet">👪</span>Integrantes</h2>
    <div class="grid">${members.map((m) => memberCard(m, viewer)).join("") || `<div class="card">Todavía no hay nadie registrado.</div>`}</div>
    <details class="add-member"><summary>+ Agregar integrante</summary>
      <form method="post" action="/familia/integrante">
        <input type="text" name="nombre" placeholder="Nombre" required>
        <input type="text" name="rol" placeholder="Rol (papá, mamá, hijo…)">
        <label class="chk"><input type="checkbox" name="acceso" value="full"> Acceso completo (chatea directo)</label>
        <input type="date" name="fechaNacimiento">
        <input type="number" step="0.1" name="pesoKg" placeholder="Peso (kg)">
        <input type="number" step="0.1" name="estaturaCm" placeholder="Estatura (cm)">
        <input type="text" name="tallaRopa" placeholder="Talla de ropa">
        <input type="text" name="nacionalidad" placeholder="Nacionalidad">
        <input type="text" name="preferenciasComida" placeholder="Le gusta comer…">
        <input type="text" name="alergias" placeholder="Alergias / restricciones">
        <select name="objetivoNutricional">${goalOptions(null)}</select>
        <select name="nivelFisico">${fitnessOptions(null)}</select>
        <input type="text" name="tiempoDisponible" placeholder="Tiempo disponible (ej. 3x/sem 30min)">
        <input type="text" name="lesiones" placeholder="Lesiones / limitaciones">
        <input type="text" name="dondeEjercicio" placeholder="Dónde entrena (gimnasio, casa sin equipo, con mancuernas…)">
        <input type="text" name="intereses" placeholder="Intereses / gustos (útil en niños)">
        <button type="submit">Guardar integrante</button>
      </form>
    </details>`;
  return layout(env, "Integrantes", "integrantes", body);
}

// ── Página: Tareas (diarias, puntuales, ejercicio, asignadas) ──────────

export async function renderTareasPage(env: Env): Promise<string> {
  const { withPending, nameById } = await loadChores(env);
  const members = await listMembers(db(env));

  const diarias = withPending.filter((x) => x.c.category === "tarea" && x.c.kind === "diaria");
  const puntuales = withPending.filter((x) => x.c.category === "tarea" && x.c.kind === "puntual");
  const ejercicio = withPending.filter((x) => x.c.category === "ejercicio");

  const asignadasPend = withPending.filter((x) => x.pending && x.c.assigned_to);
  const byMember = new Map<string, typeof asignadasPend>();
  for (const x of asignadasPend) {
    const key = x.c.assigned_to!;
    if (!byMember.has(key)) byMember.set(key, []);
    byMember.get(key)!.push(x);
  }
  const asignadasHtml = byMember.size
    ? Array.from(byMember.entries())
        .map(([memberId, items]) => `<div class="assignee-block"><h4>${esc(nameById.get(memberId) ?? "?")}</h4>${choreList(items, nameById, "", true)}</div>`)
        .join("")
    : `<p class="empty-row">Nadie tiene pendientes asignados ahorita.</p>`;

  const body = `
    ${section("diarias", "📋", "Tareas diarias", choreList(diarias, nameById, "Sin tareas diarias registradas.") + addChoreForm(members, "diaria", "tarea"))}
    ${section("puntuales", "✅", "Tareas puntuales", choreList(puntuales, nameById, "Sin tareas puntuales pendientes.") + addChoreForm(members, "puntual", "tarea"))}
    ${section("asignadas", "🙋", "Quién hace qué", asignadasHtml)}
    <p class="soon-note">El ejercicio tiene su propia página → <a href="/familia/ejercicio">Actividad física</a>.</p>
  `;
  return layout(env, "Tareas", "tareas", body);
}

// ── Página: Actividad física ────────────────────────────────────────────

export async function renderEjercicioPage(env: Env): Promise<string> {
  const d = db(env);
  const { withPending, nameById } = await loadChores(env);
  const ejercicio = withPending.filter((x) => x.c.category === "ejercicio");
  const members = await listMembers(d);

  const plans = await d.all<{ member_id: string; plan_text: string }>("SELECT member_id, plan_text FROM exercise_plan");
  const planByMember = new Map(plans.map((p) => [p.member_id, p.plan_text]));

  const planCard = (m: FamilyMember) => {
    const plan = planByMember.get(m.id);
    const mine = ejercicio.filter((x) => x.c.assigned_to === m.id);
    const done = mine.filter((x) => !x.pending).length;
    return `<div class="card">
      <div class="card-head"><h3>${esc(m.name)}</h3>${mine.length ? `<span class="badge ${done === mine.length ? "ok" : "pending"}">${mine.length - done}/${mine.length} pendiente${mine.length - done === 1 ? "" : "s"}</span>` : ""}</div>
      ${plan ? `<details><summary>Ver plan semanal</summary><div class="recipe">${esc(plan).replace(/\n/g, "<br>")}</div></details>` : `<p class="empty">Sin plan todavía — pídeselo al bot: "arma mi rutina de ejercicio".</p>`}
    </div>`;
  };

  const body = `
    <div class="grid">${members.map(planCard).join("") || `<div class="card">Todavía no hay integrantes.</div>`}</div>
    ${section("ejercicio", "🏃", "Sesiones de esta semana", groupedChoreList(ejercicio, nameById, "Sin rutinas registradas todavía.") + addChoreForm(members, "puntual", "ejercicio"), "orange")}
    <p class="soon-note">Para un plan personalizado (nivel, tiempo disponible, lesiones), pídeselo al bot por chat: "arma mi rutina de ejercicio" — usa tu perfil físico, editable en Integrantes.</p>
  `;
  return layout(env, "Ejercicio", "ejercicio", body);
}

// ── Página: Menú de hoy ─────────────────────────────────────────────────

function addDaysStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function dayLabel(dateStr: string, offset: number): string {
  if (offset === 0) return "Hoy";
  if (offset === 1) return "Mañana";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "UTC" }).format(dt);
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

function mealBlock(icon: string, label: string, dish: string | null, recipe: string | null): string {
  if (!dish && !recipe) return `<div class="meal-slot empty"><span class="meal-icon">${icon}</span><span class="meal-empty">${esc(label)} sin definir</span></div>`;
  return `<div class="meal-slot">
    <span class="meal-icon">${icon}</span>
    <div class="meal-body">
      <b>${esc(dish || label)}</b>
      ${recipe ? `<details><summary>Ver ingredientes y receta</summary><div class="recipe">${esc(recipe).replace(/\n/g, "<br>")}</div></details>` : ""}
    </div>
  </div>`;
}

export async function renderMenuPage(env: Env): Promise<string> {
  const today = todayInTZ(env);
  const d = db(env);
  const todayRow = await d.first<{ breakfast: string | null; lunch: string | null; dinner: string | null }>(
    "SELECT breakfast, lunch, dinner FROM meal_plan WHERE date = ?",
    [today],
  );

  type MealRow = { date: string; breakfast: string | null; breakfast_recipe: string | null; lunch: string | null; lunch_recipe: string | null; dinner: string | null; dinner_recipe: string | null };
  const weekDates = Array.from({ length: 7 }, (_, i) => addDaysStr(today, i));
  const rows = await d.all<MealRow>(
    `SELECT date, breakfast, breakfast_recipe, lunch, lunch_recipe, dinner, dinner_recipe FROM meal_plan WHERE date IN (${weekDates.map(() => "?").join(",")})`,
    weekDates,
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const dayCard = (date: string, offset: number) => {
    const r = byDate.get(date);
    return `<div class="day-card">
      <h4>${esc(dayLabel(date, offset))} <span class="day-date">${date.slice(8)}/${date.slice(5, 7)}</span></h4>
      ${mealBlock("🌅", "Desayuno", r?.breakfast ?? null, r?.breakfast_recipe ?? null)}
      ${mealBlock("🍲", "Comida", r?.lunch ?? null, r?.lunch_recipe ?? null)}
      ${mealBlock("🌙", "Cena", r?.dinner ?? null, r?.dinner_recipe ?? null)}
    </div>`;
  };

  const body = `
    <section class="panel">
      <h2><span class="icon-badge tone-rose">✏️</span>Editar menú de hoy (rápido)</h2>
      <form class="menu-form" method="post" action="/familia/menu">
        <label>Desayuno<input type="text" name="desayuno" value="${esc(todayRow?.breakfast || "")}"></label>
        <label>Comida<input type="text" name="comida" value="${esc(todayRow?.lunch || "")}"></label>
        <label>Cena<input type="text" name="cena" value="${esc(todayRow?.dinner || "")}"></label>
        <button type="submit">Guardar</button>
      </form>
      <p class="soon-note">Para ingredientes y receta paso a paso pídeselo al bot por chat: "arma el menú de la semana" — usa los gustos, alergias y objetivo de cada integrante.</p>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-rose">📅</span>Semana</h2>
      <div class="week-grid">${weekDates.map((date, i) => dayCard(date, i)).join("")}</div>
    </section>`;
  return layout(env, "Menú", "menu", body);
}

// ── Página: Lista de la compra ──────────────────────────────────────────

export async function renderCompraPage(env: Env): Promise<string> {
  const shopping = await db(env).all<{ id: string; name: string; category: string | null; quantity: string | null; prep_note: string | null; status: string }>(
    "SELECT id, name, category, quantity, prep_note, status FROM shopping_items ORDER BY status ASC, created_at ASC",
  );
  const shoppingPending = shopping.filter((s) => s.status === "pending");
  const shoppingItem = (s: (typeof shopping)[number]) => `<li class="${s.status === "bought" ? "done" : ""}">
    <label>
      <input type="checkbox" data-toggle="/familia/compra/${s.id}/toggle" ${s.status === "bought" ? "checked" : ""}>
      <div class="rem-info">
        <span class="txt">${esc(s.name)}${s.quantity ? ` <span class="meta">· ${esc(s.quantity)}</span>` : ""}</span>
        ${s.category || s.prep_note ? `<span class="meta">${[s.category, s.prep_note ? `❄️ ${s.prep_note}` : null].filter((x): x is string => Boolean(x)).map(esc).join(" · ")}</span>` : ""}
      </div>
    </label>
    <span class="row-right">
      <button class="del" data-del="/familia/compra/${s.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;

  const body = section(
    "compra",
    "🛒",
    `Lista de la compra (${shoppingPending.length} pendiente${shoppingPending.length === 1 ? "" : "s"})`,
    `<ul class="chores rem-list">${shopping.length ? shopping.map(shoppingItem).join("") : `<li class="empty-row">La lista está vacía.</li>`}</ul>
     <form class="add-form" method="post" action="/familia/compra">
       <input type="text" name="nombre" placeholder="Nuevo producto…" required>
       <input type="text" name="cantidad" placeholder="Cantidad (ej. 1 kg)">
       <input type="text" name="categoria" placeholder="Categoría (opcional)">
       <button type="submit">+ Agregar</button>
     </form>
     <p class="soon-note">Pídele al bot "arma la lista de compras de la semana" — calcula cantidades según el menú y cuántos son, y te dice qué picar y congelar para que no se dañe.</p>`,
    "amber",
  );
  return layout(env, "Compra", "compra", body);
}

// ── Páginas "próximamente" ───────────────────────────────────────────────

export async function renderRecordatoriosPage(env: Env): Promise<string> {
  const d = db(env);
  const members = await listMembers(d);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const rows = await d.all<Reminder>("SELECT * FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC LIMIT 50");

  const repeatLabel: Record<string, string> = { diario: "cada día", semanal: "cada semana", mensual: "cada mes" };
  const item = (r: Reminder) => `<li>
    <div class="rem-info">
      <span class="txt">${esc(r.title)}</span>
      <span class="meta">${esc(formatDateTimeInTZ(r.remind_at, env))} · ${r.target_member ? esc(nameById.get(r.target_member) ?? "?") : "todos"}${r.repeat ? ` · ${esc(repeatLabel[r.repeat] ?? r.repeat)}` : ""}</span>
    </div>
    <button class="del" data-del="/familia/recordatorio/${r.id}/borrar" title="Cancelar">✕</button>
  </li>`;

  const body = `<section class="panel">
    <h2><span class="icon-badge tone-red">⏰</span>Próximos recordatorios</h2>
    <ul class="chores rem-list">${rows.length ? rows.map(item).join("") : `<li class="empty-row">No hay recordatorios programados.</li>`}</ul>
    <form class="add-form rem-form" method="post" action="/familia/recordatorio">
      <input type="text" name="titulo" placeholder="¿Qué hay que recordar?" required>
      <input type="date" name="fecha" required>
      <input type="time" name="hora" required>
      <select name="paraQuien"><option value="">Todos</option>${assigneeOptions(members)}</select>
      <select name="repetir">
        <option value="">No se repite</option>
        <option value="diario">Cada día</option>
        <option value="semanal">Cada semana</option>
        <option value="mensual">Cada mes</option>
      </select>
      <button type="submit">+ Programar</button>
    </form>
  </section>`;
  return layout(env, "Recordatorios", "recordatorios", body);
}

export async function currencySymbol(env: Env): Promise<string> {
  const row = await db(env).first<{ value: string }>("SELECT value FROM settings WHERE key = 'bot_currency'");
  return row?.value || "€";
}

export async function renderFinanzasPage(env: Env, viewer: FamilyMember | null): Promise<string> {
  const d = db(env);
  const cur = await currencySymbol(env);
  const month = todayInTZ(env).slice(0, 7);
  const admin = isAdminViewer(viewer);

  const allRows = await d.all<Transaction>(
    "SELECT * FROM transactions WHERE substr(date, 1, 7) = ? ORDER BY date DESC, created_at DESC",
    [month],
  );
  const rows = allRows.filter((r) => r.visibility !== "privado" || admin || r.member_id === viewer?.id);
  const totalIngresos = rows.filter((r) => r.type === "ingreso").reduce((s, r) => s + r.amount, 0);
  const totalGastos = rows.filter((r) => r.type === "gasto").reduce((s, r) => s + r.amount, 0);
  const balance = totalIngresos - totalGastos;

  const byCategory = new Map<string, number>();
  for (const r of rows.filter((r) => r.type === "gasto")) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + r.amount);

  const budgets = await d.all<Budget>("SELECT * FROM budgets ORDER BY category ASC");

  const budgetRow = (b: Budget) => {
    const spent = byCategory.get(b.category) ?? 0;
    const pct = Math.min(100, Math.round((spent / b.monthly_limit) * 100));
    const over = spent > b.monthly_limit;
    return `<div class="budget-row">
      <div class="budget-head"><b>${esc(b.category)}</b><span class="${over ? "over" : ""}">${spent.toFixed(2)}${cur} / ${b.monthly_limit.toFixed(2)}${cur}</span></div>
      <div class="budget-bar"><div class="budget-fill ${over ? "over" : ""}" style="width:${pct}%"></div></div>
    </div>`;
  };

  const memberRows = await listMembers(d);
  const nameById = new Map(memberRows.map((m) => [m.id, m.name]));
  const txRow = (t: Transaction) => `<li>
    <div class="rem-info">
      <span class="txt">${t.type === "gasto" ? "🔻" : "🔺"} ${esc(t.description || t.category)}${t.visibility === "privado" ? " 🔒" : ""}</span>
      <span class="meta">${esc(t.category)} · ${esc(t.date)}${t.member_id ? ` · ${esc(nameById.get(t.member_id) ?? "")}` : ""}</span>
    </div>
    <span class="row-right">
      <b class="${t.type === "gasto" ? "amount-out" : "amount-in"}">${t.type === "gasto" ? "-" : "+"}${t.amount.toFixed(2)}${cur}</b>
      <a class="link-btn" href="/familia/transaccion/${t.id}/editar" title="Editar">✏️</a>
      <button class="del" data-del="/familia/transaccion/${t.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;

  const funds = await d.all<FinanceFund>("SELECT * FROM finance_funds ORDER BY created_at ASC");
  const FUND_KIND_LABEL: Record<string, string> = { porcentaje: "%", fijo: "fijo/mes", ahorro: "ahorro" };
  const fundsWithBalance = await Promise.all(funds.map(async (f) => ({ f, saldo: await fundBalance(d, f.id) })));

  const totalAhorrado = fundsWithBalance.filter((x) => x.f.kind === "ahorro").reduce((s, x) => s + x.saldo, 0);
  const fijos = fundsWithBalance.filter((x) => x.f.kind === "fijo");
  const totalFijoMeta = fijos.reduce((s, x) => s + (x.f.monthly_target ?? 0), 0);
  const totalFijoCubierto = fijos.reduce((s, x) => s + Math.min(x.saldo, x.f.monthly_target ?? 0), 0);

  const fundRow = ({ f, saldo }: { f: FinanceFund; saldo: number }) => {
    const target = f.kind === "fijo" ? f.monthly_target : null;
    const pct = target ? Math.min(100, Math.round((saldo / target) * 100)) : null;
    return `<div class="budget-row">
      <div class="budget-head">
        <b>${esc(f.name)} <span class="meta">(${FUND_KIND_LABEL[f.kind] ?? f.kind}${f.kind === "porcentaje" ? ` ${f.percentage}%` : ""})</span></b>${f.is_subscription ? ` <span class="badge managed">📱 suscripción</span>` : ""}
        <span class="row-right">
          <span class="${saldo < 0 ? "over" : ""}">${saldo.toFixed(2)}${cur}${target ? ` / ${target.toFixed(2)}${cur}` : ""}</span>
          <button class="del" data-del="/familia/fondo/${f.id}/borrar" title="Borrar">✕</button>
        </span>
      </div>
      ${pct != null ? `<div class="budget-bar"><div class="budget-fill ${saldo < 0 ? "over" : ""}" style="width:${Math.max(0, pct)}%"></div></div>` : ""}
    </div>`;
  };
  const fundsHtml = fundsWithBalance.length ? fundsWithBalance.map(fundRow).join("") : `<p class="empty-row">Sin sobres definidos — pídele al bot: "quiero guardar 10% para imprevistos y 10% para actividades".</p>`;
  const resultadosHtml = fundsWithBalance.length
    ? `<div class="menu-grid results-grid">
        <div><span>Ahorro total</span><b class="amount-in">${totalAhorrado.toFixed(2)}${cur}</b></div>
        <div><span>Gastos fijos cubiertos</span><b>${totalFijoCubierto.toFixed(2)}${cur} / ${totalFijoMeta.toFixed(2)}${cur}</b></div>
      </div>`
    : "";

  const fijoNames = new Set(fijos.map((x) => x.f.name.toLowerCase()));
  const ingresos = rows.filter((r) => r.type === "ingreso");
  const gastosFijos = rows.filter((r) => r.type === "gasto" && fijoNames.has(r.category.toLowerCase()));
  const gastosDiarios = rows.filter((r) => r.type === "gasto" && !fijoNames.has(r.category.toLowerCase()));

  const maxIO = Math.max(totalIngresos, totalGastos, 1);
  const ioChart = `<div class="chart-bars io-chart">
    <div class="chart-row">
      <span class="chart-label">Ingresos</span>
      <div class="chart-track"><div class="chart-fill in" style="width:${Math.max(2, Math.round((totalIngresos / maxIO) * 100))}%"></div></div>
      <span class="chart-value">${totalIngresos.toFixed(2)}${cur}</span>
    </div>
    <div class="chart-row">
      <span class="chart-label">Gastos</span>
      <div class="chart-track"><div class="chart-fill out" style="width:${Math.max(2, Math.round((totalGastos / maxIO) * 100))}%"></div></div>
      <span class="chart-value">${totalGastos.toFixed(2)}${cur}</span>
    </div>
  </div>`;

  const catEntries = Array.from(byCategory.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxCat = Math.max(...catEntries.map(([, v]) => v), 1);
  const catChart = catEntries.length
    ? `<div class="chart-bars">${catEntries
        .map(
          ([cat, amt]) => `<div class="chart-row" title="${esc(cat)}: ${amt.toFixed(2)}${cur}">
      <span class="chart-label">${esc(cat)}</span>
      <div class="chart-track"><div class="chart-fill" style="width:${Math.max(2, Math.round((amt / maxCat) * 100))}%"></div></div>
      <span class="chart-value">${amt.toFixed(2)}${cur}</span>
    </div>`,
        )
        .join("")}</div>`
    : `<p class="empty-row">Sin gastos este mes todavía.</p>`;

  const subscriptions = fijos.filter((x) => x.f.is_subscription);
  const totalSuscripciones = subscriptions.reduce((s, x) => s + (x.f.monthly_target ?? 0), 0);
  const maxSub = Math.max(...subscriptions.map((x) => x.f.monthly_target ?? 0), 1);
  const subsChart = subscriptions.length
    ? `<div class="chart-bars">${subscriptions
        .map(
          (x) => `<div class="chart-row" title="${esc(x.f.name)}: ${(x.f.monthly_target ?? 0).toFixed(2)}${cur}/mes">
      <span class="chart-label">${esc(x.f.name)}</span>
      <div class="chart-track"><div class="chart-fill" style="width:${Math.max(2, Math.round(((x.f.monthly_target ?? 0) / maxSub) * 100))}%"></div></div>
      <span class="chart-value">${(x.f.monthly_target ?? 0).toFixed(2)}${cur}</span>
    </div>`,
        )
        .join("")}</div>`
    : `<p class="empty-row">Sin suscripciones registradas — pídele al bot: "tengo Netflix a 12.99 y ChatGPT a 20, márcalos como suscripción".</p>`;

  const body = `
    <section class="panel">
      <h2><span class="icon-badge tone-blue">💶</span>Este mes</h2>
      <div class="menu-grid">
        <div><span>Ingresos</span><b>${totalIngresos.toFixed(2)}${cur}</b></div>
        <div><span>Gastos</span><b>${totalGastos.toFixed(2)}${cur}</b></div>
        <div><span>Disponible</span><b class="${balance < 0 ? "amount-out" : "amount-in"}">${balance.toFixed(2)}${cur}</b></div>
      </div>
      ${ioChart}
      <h3 class="chart-subtitle">Gastos por categoría</h3>
      ${catChart}
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">📱</span>Suscripciones y pagos recurrentes</h2>
      <div class="menu-grid">
        <div><span>Activas</span><b>${subscriptions.length}</b></div>
        <div><span>Total al mes</span><b class="amount-out">${totalSuscripciones.toFixed(2)}${cur}</b></div>
      </div>
      ${subsChart}
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">💰</span>Sobres / fondos</h2>
      ${resultadosHtml}
      ${fundsHtml}
      <form class="add-form" method="post" action="/familia/fondo">
        <input type="text" name="nombre" placeholder="Nombre (ej. Imprevistos)" required>
        <select name="tipo">
          <option value="porcentaje">% de cada ingreso</option>
          <option value="fijo">Monto fijo mensual</option>
          <option value="ahorro">Ahorro (lo que sobre)</option>
        </select>
        <input type="number" step="0.1" name="porcentaje" placeholder="% (si aplica)">
        <input type="number" step="0.01" name="montoMensual" placeholder="Meta mensual (si aplica)">
        <label class="chk"><input type="checkbox" name="esSuscripcion" value="1"> Es una suscripción/app (Netflix, ChatGPT, gimnasio…)</label>
        <button type="submit">+ Crear sobre</button>
      </form>
      <p class="soon-note">Al registrar un ingreso, se reparte solo: primero los % , luego los fijos hasta su meta del mes, el resto a ahorro.</p>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">🎯</span>Presupuestos simples</h2>
      ${budgets.length ? budgets.map(budgetRow).join("") : `<p class="empty-row">Sin presupuestos definidos todavía.</p>`}
      <form class="add-form" method="post" action="/familia/presupuesto">
        <input type="text" name="categoria" placeholder="Categoría (o 'Total')" required>
        <input type="number" step="0.01" name="montoMensual" placeholder="Límite mensual" required>
        <button type="submit">Guardar presupuesto</button>
      </form>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">🔺</span>Ingresos del mes</h2>
      <ul class="chores rem-list">${ingresos.length ? ingresos.map(txRow).join("") : `<li class="empty-row">Sin ingresos este mes.</li>`}</ul>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">📅</span>Gastos fijos del mes</h2>
      <ul class="chores rem-list">${gastosFijos.length ? gastosFijos.map(txRow).join("") : `<li class="empty-row">Sin gastos fijos registrados este mes.</li>`}</ul>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-blue">🛍️</span>Gastos diarios del mes</h2>
      <ul class="chores rem-list">${gastosDiarios.length ? gastosDiarios.map(txRow).join("") : `<li class="empty-row">Sin gastos variables este mes.</li>`}</ul>
      <form class="add-form" method="post" action="/familia/transaccion">
        <select name="tipo"><option value="gasto">Gasto</option><option value="ingreso">Ingreso</option></select>
        <input type="number" step="0.01" name="monto" placeholder="Monto" required>
        <input type="text" name="categoria" placeholder="Categoría" required>
        <input type="text" name="descripcion" placeholder="Descripción / fuente (opcional)">
        <input type="text" name="fondo" placeholder="Sobre del que sale (gastos, opcional)">
        <input type="date" name="fecha">
        <label class="chk"><input type="checkbox" name="privado" value="1"> Privado (solo yo y los admins la vemos)</label>
        <button type="submit">+ Registrar movimiento</button>
      </form>
    </section>`;
  return layout(env, "Finanzas", "finanzas", body);
}

// ── Página: Créditos y préstamos (con simulador "qué pasa si...") ──────

function twoBarChart(cur: string, label1: string, v1: number, label2: string, v2: number, fmt: (n: number) => string): string {
  const max = Math.max(v1, v2, 1);
  return `<div class="chart-bars chart-bars-wide">
    <div class="chart-row"><span class="chart-label" title="${esc(label1)}">${esc(label1)}</span><div class="chart-track"><div class="chart-fill" style="width:${Math.max(2, Math.round((v1 / max) * 100))}%"></div></div><span class="chart-value">${fmt(v1)}</span></div>
    <div class="chart-row"><span class="chart-label" title="${esc(label2)}">${esc(label2)}</span><div class="chart-track"><div class="chart-fill in" style="width:${Math.max(2, Math.round((v2 / max) * 100))}%"></div></div><span class="chart-value">${fmt(v2)}</span></div>
  </div>`;
}

export async function renderCreditosPage(env: Env, query: Record<string, string>): Promise<string> {
  const d = db(env);
  const cur = await currencySymbol(env);
  const debts = await d.all<Debt>("SELECT * FROM debts ORDER BY created_at ASC");

  const debtRow = (dd: Debt) => {
    const payoff = loanPayoff(dd.balance, dd.annual_rate, dd.monthly_payment);
    return `<div class="budget-row">
      <div class="budget-head">
        <b>${esc(dd.name)} <span class="meta">(${dd.annual_rate != null ? `${dd.annual_rate}% anual` : "sin tasa"})</span></b>
        <span class="row-right">
          <span>${dd.balance.toFixed(2)}${cur} · pago ${dd.monthly_payment.toFixed(2)}${cur}/mes</span>
          <button class="del" data-del="/familia/deuda/${dd.id}/borrar" title="Borrar">✕</button>
        </span>
      </div>
      <p class="soon-note" style="margin:6px 0 0;">${payoff ? `${payoff.months} meses restantes · ${payoff.totalInterest.toFixed(2)}${cur} de interés total` : "⚠️ El pago actual no cubre ni el interés — así nunca se paga."}</p>
    </div>`;
  };
  const debtsHtml = debts.length ? debts.map(debtRow).join("") : `<p class="empty-row">Sin créditos ni préstamos registrados.</p>`;

  const debtOptions = debts.map((dd) => `<option value="${esc(dd.name)}" ${query.deuda === dd.name ? "selected" : ""}>${esc(dd.name)}</option>`).join("");

  let simHtml = "";
  const chosen = debts.find((dd) => dd.name === query.deuda);
  if (chosen && (query.extra || query.abono)) {
    const actual = loanPayoff(chosen.balance, chosen.annual_rate, chosen.monthly_payment);
    const extra = query.extra ? Number(query.extra) : 0;
    const abono = query.abono ? Number(query.abono) : 0;
    const blocks: string[] = [];
    if (actual) {
      if (extra > 0) {
        const nuevo = loanPayoff(chosen.balance, chosen.annual_rate, chosen.monthly_payment + extra);
        blocks.push(`<h4>Pagando ${extra.toFixed(2)}${cur} más al mes</h4>
          ${twoBarChart(cur, "Meses (actual)", actual.months, `Meses (+${cur}${extra})`, nuevo?.months ?? 0, (n) => `${n} meses`)}
          ${nuevo ? `<p class="soon-note">Te ahorrarías <b>${(actual.months - nuevo.months)}</b> meses y <b>${(actual.totalInterest - nuevo.totalInterest).toFixed(2)}${cur}</b> de interés.</p>` : ""}`);
      }
      if (abono > 0) {
        const saldoReducido = Math.max(0, chosen.balance - abono);
        const nuevo = loanPayoff(saldoReducido, chosen.annual_rate, chosen.monthly_payment);
        blocks.push(`<h4>Abonando ${abono.toFixed(2)}${cur} de golpe hoy</h4>
          ${twoBarChart(cur, "Meses (actual)", actual.months, "Meses (con abono)", nuevo?.months ?? 0, (n) => `${n} meses`)}
          ${nuevo ? `<p class="soon-note">Te ahorrarías <b>${(actual.months - nuevo.months)}</b> meses y <b>${(actual.totalInterest - nuevo.totalInterest).toFixed(2)}${cur}</b> de interés.</p>` : ""}`);
      }
    }
    simHtml = blocks.length ? `<div class="panel" style="margin-top:14px;"><h3 class="chart-subtitle">Simulación: ${esc(chosen.name)}</h3>${blocks.join("<hr style='border:none;border-top:1px solid #f0f0f3;margin:16px 0;'>")}</div>` : "";
  }

  const body = `
    <section class="panel">
      <h2><span class="icon-badge tone-cyan">💳</span>Créditos y préstamos</h2>
      ${debtsHtml}
      <form class="add-form" method="post" action="/familia/deuda">
        <input type="text" name="nombre" placeholder="Nombre (ej. Tarjeta)" required>
        <input type="number" step="0.01" name="saldo" placeholder="Saldo actual" required>
        <input type="number" step="0.01" name="tasaAnual" placeholder="Tasa anual % (opcional)">
        <input type="number" step="0.01" name="pagoMensual" placeholder="Pago mensual" required>
        <button type="submit">+ Guardar</button>
      </form>
    </section>
    ${
      debts.length
        ? `<section class="panel">
      <h2><span class="icon-badge tone-cyan">🔮</span>Simulador: "¿qué pasa si...?"</h2>
      <form method="get" action="/familia/creditos" class="add-form">
        <select name="deuda">${debtOptions}</select>
        <input type="number" step="0.01" name="extra" placeholder="Pagar más al mes (opcional)" value="${esc(query.extra || "")}">
        <input type="number" step="0.01" name="abono" placeholder="Abonar de golpe hoy (opcional)" value="${esc(query.abono || "")}">
        <button type="submit">Simular</button>
      </form>
    </section>
    ${simHtml}`
        : ""
    }`;
  return layout(env, "Créditos", "creditos", body);
}

const KIND_LABEL: Record<string, string> = { casa: "🏠 En casa", aire_libre: "🌳 Al aire libre", fin_semana: "🎉 Fin de semana" };

function activityItem(a: FamilyActivity, memberName: string | null): string {
  return `<li class="${a.is_favorite ? "done" : ""}">
    <label>
      <input type="checkbox" data-toggle="/familia/actividad/${a.id}/favorita" ${a.is_favorite ? "checked" : ""}>
      <span class="txt">${esc(a.title)}${a.is_favorite ? " ⭐" : ""}</span>
    </label>
    <span class="row-right">
      <span class="meta">${[KIND_LABEL[a.kind] ?? a.kind, memberName].filter(Boolean).join(" · ")}</span>
      <button class="del" data-del="/familia/actividad/${a.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;
}

export async function renderNinosPage(env: Env): Promise<string> {
  const d = db(env);
  const members = await listMembers(d);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const kids = members.filter((m) => m.access_level === "managed");
  const activities = await d.all<FamilyActivity>("SELECT * FROM family_activities ORDER BY is_favorite DESC, created_at DESC");

  const kidCard = (m: FamilyMember) => {
    const edad = ageFromBirthdate(m.birthdate);
    return `<div class="card">
      <div class="card-head"><h3>${esc(m.name)}</h3></div>
      <div class="role" style="text-transform:none">${edad != null ? `${edad} año${edad === 1 ? "" : "s"}` : ""}</div>
      ${m.interests ? `<div class="row"><span>Le gusta</span><b>${esc(m.interests)}</b></div>` : `<div class="empty">Sin intereses guardados</div>`}
      <a class="edit-link" href="/familia/integrante/${m.id}/editar">✏️ Editar</a>
    </div>`;
  };

  const body = `
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">🧸</span>Niños</h2>
      <div class="grid">${kids.map(kidCard).join("") || `<div class="card">No hay integrantes marcados como "acceso gestionado" (niños) todavía.</div>`}</div>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">🎲</span>Actividades familiares</h2>
      <ul class="chores">${activities.length ? activities.map((a) => activityItem(a, a.for_member ? nameById.get(a.for_member) ?? null : null)).join("") : `<li class="empty-row">Sin actividades guardadas — pídele al bot ideas: "actividades para el fin de semana con Aday".</li>`}</ul>
      <form class="add-form" method="post" action="/familia/actividad">
        <input type="text" name="titulo" placeholder="Nueva actividad…" required>
        <select name="tipo">
          <option value="casa">En casa</option>
          <option value="aire_libre">Al aire libre</option>
          <option value="fin_semana">Fin de semana</option>
        </select>
        <select name="paraQuien"><option value="">Toda la familia</option>${assigneeOptions(members)}</select>
        <button type="submit">+ Agregar</button>
      </form>
      <p class="soon-note">Marca ⭐ la casilla de una actividad cuando ya la probaron y funcionó, para acordarte de repetirla.</p>
    </section>`;
  return layout(env, "Niños", "ninos", body);
}

// ── Página: Recompensas (estrellas, tienda y logros) ─────────────────────

export async function renderRecompensasPage(env: Env): Promise<string> {
  const d = db(env);
  const members = await listMembers(d);
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  const balances = await Promise.all(members.map(async (m) => ({ m, balance: await starBalance(d, m.id) })));
  const achievements = await d.all<{ member_id: string; badge_key: string }>("SELECT member_id, badge_key FROM achievements_earned");
  const badgesByMember = new Map<string, string[]>();
  for (const a of achievements) {
    const list = badgesByMember.get(a.member_id) ?? [];
    list.push(a.badge_key);
    badgesByMember.set(a.member_id, list);
  }

  const memberCard = ({ m, balance }: { m: FamilyMember; balance: number }) => {
    const badges = badgesByMember.get(m.id) ?? [];
    return `<div class="card">
      <div class="card-head"><h3>${esc(m.name)}</h3><span class="badge ok">${balance} ⭐</span></div>
      <div class="role">${esc(m.role)}</div>
      ${badges.length ? `<div class="row"><span>Logros</span><b>${badges.map((k) => ACHIEVEMENT_CATALOG[k]?.emoji ?? "🏅").join(" ")}</b></div>` : `<div class="empty">Sin logros todavía</div>`}
    </div>`;
  };

  const activities = await d.all<StarActivity>("SELECT * FROM star_activities ORDER BY points DESC");
  const rewards = await d.all<Reward>("SELECT * FROM rewards ORDER BY cost_stars ASC");
  const pending = await d.all<RewardRedemption>("SELECT * FROM reward_redemptions WHERE status = 'pending' ORDER BY created_at ASC");

  const memberOptions = members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");

  const activityRow = (a: StarActivity) => `<li>
    <span class="txt">${esc(a.name)}</span>
    <span class="row-right">
      <span class="meta">${a.points} ⭐</span>
      <button class="del" data-del="/familia/actividad-estrella/${a.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;

  const rewardRow = (r: Reward) => `<li>
    <div class="rem-info">
      <span class="txt">${esc(r.name)}</span>
      <form method="post" action="/familia/canje" style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
        <input type="hidden" name="recompensaId" value="${r.id}">
        <select name="integranteId" required style="flex:1 1 130px;"><option value="">Canjear para…</option>${memberOptions}</select>
        <button type="submit" class="btn-secondary" style="padding:5px 10px;font-size:.78rem;">Solicitar</button>
      </form>
    </div>
    <span class="row-right">
      <span class="meta">${r.cost_stars} ⭐</span>
      <button class="del" data-del="/familia/recompensa/${r.id}/borrar" title="Borrar">✕</button>
    </span>
  </li>`;

  const pendingRow = (p: RewardRedemption) => `<li>
    <div class="rem-info">
      <span class="txt">${esc(nameById.get(p.member_id) ?? "?")} quiere "${esc(p.reward_name)}"</span>
      <span class="meta">${p.cost_stars} ⭐</span>
    </div>
    <span class="row-right">
      <form method="post" action="/familia/canje/${p.id}/resolver" style="display:inline"><input type="hidden" name="aprobar" value="1"><button type="submit" class="btn-secondary" style="padding:5px 10px;font-size:.78rem;">✓ Aprobar</button></form>
      <form method="post" action="/familia/canje/${p.id}/resolver" style="display:inline"><input type="hidden" name="aprobar" value="0"><button type="submit" class="del" title="Rechazar">✕</button></form>
    </span>
  </li>`;

  const badgeOptions = Object.entries(ACHIEVEMENT_CATALOG)
    .map(([key, b]) => `<option value="${key}">${b.emoji} ${esc(b.label)}</option>`)
    .join("");

  const body = `
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">⭐</span>Estrellas de la familia</h2>
      <div class="grid">${balances.map(memberCard).join("") || `<div class="card">Todavía no hay integrantes.</div>`}</div>
      <form class="add-form" method="post" action="/familia/estrella">
        <select name="integranteId" required><option value="">¿Quién?</option>${memberOptions}</select>
        <select name="actividadId"><option value="">Actividad (opcional)</option>${activities.map((a) => `<option value="${a.id}">${esc(a.name)} (${a.points} ⭐)</option>`).join("")}</select>
        <input type="number" name="puntos" placeholder="O estrellas directo (usa negativo para corregir)">
        <input type="text" name="razon" placeholder="Motivo (si no elegiste actividad)">
        <button type="submit">+ Dar estrellas</button>
      </form>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">🧺</span>Actividades que ganan estrellas</h2>
      <ul class="chores">${activities.length ? activities.map(activityRow).join("") : `<li class="empty-row">Sin actividades configuradas.</li>`}</ul>
      <form class="add-form" method="post" action="/familia/actividad-estrella">
        <input type="text" name="nombre" placeholder="Nombre (ej. Hacer la cama)" required>
        <input type="number" name="puntos" placeholder="Estrellas" required>
        <button type="submit">+ Agregar</button>
      </form>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">🎁</span>Tienda de recompensas</h2>
      <ul class="chores rem-list">${rewards.length ? rewards.map(rewardRow).join("") : `<li class="empty-row">Sin recompensas configuradas.</li>`}</ul>
      <form class="add-form" method="post" action="/familia/recompensa">
        <input type="text" name="nombre" placeholder="Nombre (ej. Helado)" required>
        <input type="number" name="costo" placeholder="Costo en estrellas" required>
        <button type="submit">+ Agregar</button>
      </form>
      <p class="soon-note">Al solicitar un canje (aquí o pidiéndoselo al bot) queda pendiente hasta que lo apruebes abajo — no se descuentan las estrellas todavía.</p>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">⏳</span>Canjes pendientes</h2>
      <ul class="chores rem-list">${pending.length ? pending.map(pendingRow).join("") : `<li class="empty-row">Sin canjes pendientes.</li>`}</ul>
    </section>
    <section class="panel">
      <h2><span class="icon-badge tone-yellow">🏆</span>Dar un logro</h2>
      <form class="add-form" method="post" action="/familia/logro">
        <select name="integranteId" required><option value="">¿Quién?</option>${memberOptions}</select>
        <select name="logro" required><option value="">¿Qué logro?</option>${badgeOptions}</select>
        <button type="submit">🎉 Dar logro</button>
      </form>
    </section>`;
  return layout(env, "Recompensas", "recompensas", body);
}

// ── Página: editar integrante ────────────────────────────────────────────

export async function renderEditMemberPage(env: Env, id: string): Promise<string> {
  const d = db(env);
  const m = await d.first<FamilyMember>("SELECT * FROM family_members WHERE id = ?", [id]);
  if (!m) return layout(env, "Integrante no encontrado", "integrantes", `<p>No encontré a ese integrante. <a href="/familia/integrantes">Volver</a></p>`);

  const body = `<section class="panel">
    <h2>✏️ Editar a ${esc(m.name)}</h2>
    <form method="post" action="/familia/integrante/${m.id}">
      <label class="field">Nombre completo<input type="text" name="nombre" value="${esc(m.name)}" required></label>
      <label class="field">Rol<input type="text" name="rol" value="${esc(m.role)}"></label>
      <label class="chk"><input type="checkbox" name="acceso" value="full" ${m.access_level === "full" ? "checked" : ""}> Acceso completo (chatea directo con el bot)</label>
      ${m.access_level === "full" ? `<label class="field">Nivel de permiso<select name="nivelPermiso"><option value="adult" ${m.permission_tier !== "admin" ? "selected" : ""}>Adulto (usa todo)</option><option value="admin" ${m.permission_tier === "admin" ? "selected" : ""}>Administrador (gestiona el hogar)</option></select></label>` : ""}
      <label class="chk"><input type="checkbox" name="datosSaludPrivados" value="1" ${m.health_private ? "checked" : ""}> Mantener peso/salud/lesiones privado (solo esta persona y los admins lo ven)</label>
      <label class="field">Fecha de nacimiento<input type="date" name="fechaNacimiento" value="${m.birthdate ?? ""}"></label>
      <label class="field">Peso (kg)<input type="number" step="0.1" name="pesoKg" value="${m.weight_kg ?? ""}"></label>
      <label class="field">Estatura (cm)<input type="number" step="0.1" name="estaturaCm" value="${m.height_cm ?? ""}"></label>
      <label class="field">Talla de ropa<input type="text" name="tallaRopa" value="${esc(m.clothing_size ?? "")}"></label>
      <label class="field">Nacionalidad<input type="text" name="nacionalidad" value="${esc(m.nationality ?? "")}"></label>
      <label class="field">Le gusta comer<input type="text" name="preferenciasComida" value="${esc(m.food_preferences ?? "")}"></label>
      <label class="field">Alergias / restricciones<input type="text" name="alergias" value="${esc(m.allergies ?? "")}"></label>
      <label class="field">Objetivo nutricional<select name="objetivoNutricional">${goalOptions(m.nutrition_goal)}</select></label>
      <label class="field">Nivel físico<select name="nivelFisico">${fitnessOptions(m.fitness_level)}</select></label>
      <label class="field">Tiempo disponible<input type="text" name="tiempoDisponible" value="${esc(m.time_available ?? "")}"></label>
      <label class="field">Lesiones / limitaciones<input type="text" name="lesiones" value="${esc(m.injuries ?? "")}"></label>
      <label class="field">Dónde entrena / equipo disponible<input type="text" name="dondeEjercicio" value="${esc(m.exercise_setting ?? "")}" placeholder="gimnasio, casa sin equipo, con mancuernas…"></label>
      <label class="field">Intereses / gustos<input type="text" name="intereses" value="${esc(m.interests ?? "")}"></label>
      <div class="btn-row">
        <button type="submit">Guardar cambios</button>
        <a class="btn-secondary" href="/familia/integrantes">Cancelar</a>
      </div>
    </form>
    ${m.access_level === "full" ? `<form method="post" action="/familia/integrante/${m.id}/revocar" class="danger-form" onsubmit="return confirm('¿Cerrar la sesión web y desconectar el Telegram de ${esc(m.name)}? Sigue registrado, puede volver a conectarse con un enlace nuevo.');">
      <button type="submit" class="link-btn">🔒 Revocar accesos activos (Telegram + sesiones web)</button>
    </form>` : ""}
    <form method="post" action="/familia/integrante/${m.id}/borrar" class="danger-form" onsubmit="return confirm('¿Borrar a ${esc(m.name)} de la familia? No se puede deshacer.');">
      <button type="submit" class="danger">🗑 Borrar a ${esc(m.name)}</button>
    </form>
  </section>`;
  return layout(env, `Editar ${m.name}`, "integrantes", body);
}

// ── Estilos y script compartidos ───────────────────────────────────────

const SHARED_STYLE = `
  :root {
    color-scheme: light dark;
    --sans: 'Plus Jakarta Sans', -apple-system, system-ui, sans-serif;
    --accent: #2b6e63;
    --accent-dark: #1f5951;
    --accent-tint: #e2efec;
    --accent-tint-2: #dcece7;
    --bg: #f3f4f8;
    --surface: #fff;
    --border: #e5e7eb;
    --ink: #1a1f3c;
    --ink-soft: #6b7280;
    --ink-faint: #9aa0b4;
    --shadow-sm: 0 1px 2px rgba(20,25,45,.04);
    --shadow-md: 0 6px 20px rgba(20,25,45,.06);
    --radius-lg: 18px;
    --radius-md: 12px;
    --radius-sm: 8px;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family:var(--sans); background:var(--bg); color:var(--ink); -webkit-font-smoothing:antialiased; }
  h1, h2, h3, h4 { font-weight:700; letter-spacing:-.01em; }
  @media (prefers-color-scheme: dark) {
    body { background:#0e1116; color:#e8eaf2; }
    :root { --border:#2a2f3c; --ink:#e8eaf2; --ink-soft:#9aa0b4; --accent-tint:#1c2b28; --accent-tint-2:#1c2b28; --shadow-sm:0 1px 2px rgba(0,0,0,.3); --shadow-md:0 8px 24px rgba(0,0,0,.35); }
    header { background:linear-gradient(180deg,#171b24,#0e1116) !important; }
    .card, .panel, nav, .hub-card, .add-form, .add-member form, .menu-form, select, input, .field input, .field select, .day-card { background:#171b24 !important; border-color:#2a2f3c !important; color:#e8eaf2 !important; }
    .row span, .meta, .role, .hub-card p, .day-date, .recipe { color:#9aa0b4 !important; }
    li, .meal-slot { border-bottom-color:#242938 !important; border-top-color:#242938 !important; }
    .budget-bar { background:#242938; }
    .chart-track { background:#242938; }
    .chart-label { color:#9aa0b4 !important; }
    .chart-value { color:#e8eaf2 !important; }
    .invite-link-box { background:#171b24; border-color:#2a2f3c; }
    .nav-ic, .brand-badge { background:#1c2b28 !important; }
    .hub-card:hover { box-shadow:0 10px 28px rgba(0,0,0,.4) !important; }
    .hero-eyebrow { color:#9aa0b4 !important; }
    .hub-icon.tone-green, .icon-badge.tone-green { background:#123524 !important; color:#4ade80 !important; }
    .hub-icon.tone-amber, .icon-badge.tone-amber { background:#3a2a0a !important; color:#fbbf24 !important; }
    .hub-icon.tone-rose, .icon-badge.tone-rose { background:#3a1626 !important; color:#f472b6 !important; }
    .hub-icon.tone-orange, .icon-badge.tone-orange { background:#3a1f0a !important; color:#fb923c !important; }
    .hub-icon.tone-red, .icon-badge.tone-red { background:#3a1414 !important; color:#f87171 !important; }
    .hub-icon.tone-blue, .icon-badge.tone-blue { background:#122a4a !important; color:#60a5fa !important; }
    .hub-icon.tone-yellow, .icon-badge.tone-yellow { background:#3a330a !important; color:#fde047 !important; }
    .hub-icon.tone-violet, .icon-badge.tone-violet { background:#241a3a !important; color:#c4b5fd !important; }
    .hub-icon.tone-cyan, .icon-badge.tone-cyan { background:#0b2e36 !important; color:#22d3ee !important; }
  }
  header { padding:26px 20px 16px; text-align:center; background:linear-gradient(180deg,#fff,#f3f4f8); }
  .brand { display:inline-flex; align-items:center; gap:12px; }
  .brand-badge { display:flex; align-items:center; justify-content:center; width:46px; height:46px; border-radius:14px; background:var(--accent-tint); font-size:1.4rem; flex:none; }
  header h1 { margin:0; font-size:1.28rem; text-align:left; }
  header p { margin:2px 0 0; color:var(--ink-soft); font-size:.85rem; text-align:left; }
  nav { position:sticky; top:0; z-index:10; display:flex; gap:6px; overflow-x:auto; padding:10px 14px; background:var(--surface); border-bottom:1px solid var(--border); box-shadow:var(--shadow-sm); -webkit-mask-image:linear-gradient(to right, #000 calc(100% - 28px), transparent); mask-image:linear-gradient(to right, #000 calc(100% - 28px), transparent); }
  nav a { flex:none; display:inline-flex; align-items:center; gap:5px; font-size:.8rem; font-weight:600; text-decoration:none; color:var(--accent); background:var(--accent-tint); padding:9px 14px 9px 10px; border-radius:999px; white-space:nowrap; transition:background .15s ease; }
  nav a .nav-ic { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; }
  nav a.active { background:var(--accent); color:#fff; }
  main { max-width:760px; margin:0 auto; padding:16px; }
  .home-hero { padding:6px 4px 18px; }
  .hero-eyebrow { margin:0 0 2px; font-size:.78rem; font-weight:600; letter-spacing:.03em; color:var(--accent); text-transform:uppercase; }
  .home-hero h2 { margin:0; font-size:1.5rem; }
  .hub-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:12px; }
  .hub-card { display:block; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:18px; text-decoration:none; color:inherit; position:relative; box-shadow:var(--shadow-sm); transition:transform .15s ease, box-shadow .15s ease; }
  .hub-card:hover { transform:translateY(-3px); box-shadow:var(--shadow-md); }
  .hub-icon { display:flex; align-items:center; justify-content:center; width:44px; height:44px; border-radius:12px; background:var(--accent-tint); font-size:1.3rem; margin-bottom:10px; transition:transform .15s ease; }
  .hub-card:hover .hub-icon { transform:scale(1.08) rotate(-4deg); }
  .hub-icon.tone-green, .icon-badge.tone-green { background:#dcfce7; color:#16a34a; }
  .hub-icon.tone-amber, .icon-badge.tone-amber { background:#fef3c7; color:#b45309; }
  .hub-icon.tone-rose, .icon-badge.tone-rose { background:#fce7f3; color:#be185d; }
  .hub-icon.tone-orange, .icon-badge.tone-orange { background:#ffedd5; color:#c2410c; }
  .hub-icon.tone-red, .icon-badge.tone-red { background:#fee2e2; color:#b91c1c; }
  .hub-icon.tone-blue, .icon-badge.tone-blue { background:#dbeafe; color:#1d4ed8; }
  .hub-icon.tone-yellow, .icon-badge.tone-yellow { background:#fef9c3; color:#a16207; }
  .hub-icon.tone-violet, .icon-badge.tone-violet { background:#ede9fe; color:#6d28d9; }
  .hub-icon.tone-cyan, .icon-badge.tone-cyan { background:#cffafe; color:#0e7490; }
  .icon-badge { display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:9px; font-size:.95rem; margin-right:8px; flex:none; }
  .hub-card h3 { margin:0 0 4px; font-size:1rem; }
  .hub-card p { margin:0; font-size:.82rem; color:var(--ink-soft); }
  .hub-card.soon { opacity:.7; }
  .soon-tag { position:absolute; top:14px; right:14px; font-size:.62rem; background:#fef3c7; color:#b45309; padding:2px 7px; border-radius:999px; }
  .soon-panel { text-align:center; padding:36px 20px; }
  .soon-icon { font-size:2.4rem; }
  .soon-desc { color:#6b7280; font-size:.9rem; max-width:440px; margin:8px auto 18px; }
  .soon-label { font-size:.8rem; color:#9aa0b4; margin-bottom:6px; }
  .soon-list { list-style:none; padding:0; margin:0 0 20px; display:inline-block; text-align:left; }
  .soon-list li { padding:5px 0; font-size:.88rem; }
  .soon-list li::before { content:"— "; color:#2b6e63; }
  .soon-note { margin-top:12px; font-size:.78rem; color:#9aa0b4; }
  .week-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
  .day-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-md); padding:14px; box-shadow:var(--shadow-sm); }
  .day-card h4 { margin:0 0 10px; font-size:.92rem; display:flex; justify-content:space-between; }
  .day-date { color:#9aa0b4; font-weight:400; font-size:.8rem; }
  .meal-slot { display:flex; gap:8px; padding:6px 0; border-top:1px solid #f4f4f7; font-size:.85rem; }
  .day-card .meal-slot:first-of-type { border-top:none; }
  .meal-icon { flex:none; }
  .meal-body b { display:block; }
  .meal-slot.empty .meal-empty { color:#c2c6d1; font-style:italic; }
  .recipe { margin-top:6px; font-size:.8rem; color:#6b7280; line-height:1.5; white-space:pre-wrap; }
  details summary { cursor:pointer; font-size:.78rem; color:#2b6e63; margin-top:4px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:12px; margin-bottom:10px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:16px; position:relative; box-shadow:var(--shadow-sm); }
  .card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .card-head h3 { margin:0; font-size:1.02rem; }
  .role { color:#6b7280; font-size:.82rem; margin:2px 0 10px; text-transform:capitalize; }
  .row { display:flex; justify-content:space-between; gap:10px; font-size:.85rem; padding:3px 0; }
  .row span { color:var(--ink-soft); flex:none; white-space:nowrap; }
  .row b { flex:1 1 auto; min-width:0; text-align:right; overflow-wrap:break-word; }
  .empty, .empty-row { color:#9aa0b4; font-size:.85rem; }
  .badge { font-size:.68rem; padding:3px 8px; border-radius:999px; white-space:nowrap; }
  .badge.ok { background:#dcfce7; color:#16a34a; }
  .badge.pending { background:#fef3c7; color:#b45309; }
  .badge.managed { background:#dcece7; color:#2b6e63; }
  .edit-link { display:inline-block; margin-top:10px; font-size:.78rem; color:#2b6e63; text-decoration:none; }
  .card-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
  .link-btn { border:none; background:none; color:#2b6e63; font-size:.78rem; cursor:pointer; padding:0; margin-top:10px; font-family:inherit; }
  .invite-link-box { background:#f7f8fc; border:1px solid #e5e7eb; border-radius:10px; padding:14px; font-size:.85rem; word-break:break-all; margin:14px 0; user-select:all; }
  .add-member { margin-bottom:22px; }
  .add-member summary { cursor:pointer; font-size:.85rem; color:#2b6e63; padding:6px 0; }
  .add-member form, .panel form.add-form:not(.menu-form) { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .add-member input, .add-form input, .add-form select, .field input { border:1px solid var(--border); border-radius:var(--radius-sm); padding:7px 10px; font-size:.85rem; background:var(--surface); font-family:inherit; transition:border-color .15s ease; }
  .add-member input:focus, .add-form input:focus, .add-form select:focus, .field input:focus, .field select:focus, .menu-form input:focus { outline:none; border-color:var(--accent); }
  .add-member input { flex:1 1 140px; }
  .add-member button, .add-form button { border:none; background:var(--accent); color:#fff; border-radius:var(--radius-sm); padding:8px 14px; font-size:.85rem; font-weight:600; cursor:pointer; transition:background .15s ease; }
  .add-member button:hover, .add-form button:hover { background:var(--accent-dark); }
  .panel { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-lg); padding:18px; margin-bottom:16px; scroll-margin-top:56px; box-shadow:var(--shadow-sm); }
  .panel h2 { margin:0 0 12px; font-size:1.02rem; display:flex; align-items:center; }
  .page-title { margin:4px 0 14px; font-size:1.15rem; display:flex; align-items:center; }
  ul.chores { list-style:none; margin:0; padding:0; }
  ul.chores li { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:13px 2px; min-height:44px; border-bottom:1px solid #f0f0f3; font-size:.92rem; }
  ul.chores li label { padding-top:1px; }
  ul.chores li .row-right { padding-top:1px; }
  ul.chores li:last-child { border-bottom:none; }
  ul.chores label { display:flex; align-items:center; gap:10px; cursor:pointer; flex:1; min-width:0; }
  ul.chores input[type=checkbox] { width:19px; height:19px; accent-color:#2b6e63; flex:none; }
  ul.chores li.done .txt { text-decoration:line-through; color:#9aa0b4; }
  .meta { color:#9aa0b4; font-size:.78rem; }
  .row-right { display:flex; align-items:center; gap:8px; flex:none; white-space:nowrap; }
  .del { border:none; background:none; color:#d1d5db; font-size:.95rem; cursor:pointer; padding:10px; margin:-10px; }
  .rem-list li { align-items:flex-start; }
  .rem-info { display:flex; flex-direction:column; gap:2px; flex:1 1 auto; min-width:0; }
  .rem-info .txt { overflow-wrap:break-word; }
  .amount-in { color:#16a34a; }
  .amount-out { color:#b91c1c; }
  .budget-row { margin-bottom:14px; }
  .budget-row:last-of-type { margin-bottom:18px; }
  .budget-head { display:flex; justify-content:space-between; font-size:.85rem; margin-bottom:5px; }
  .budget-head span.over { color:#b91c1c; font-weight:600; }
  .budget-bar { height:8px; border-radius:999px; background:#f0f0f3; overflow:hidden; }
  .budget-fill { height:100%; background:#2b6e63; border-radius:999px; }
  .budget-fill.over { background:#ef4444; }
  .chart-subtitle { font-family:var(--sans, inherit); font-size:.82rem; text-transform:uppercase; letter-spacing:.04em; color:#9aa0b4; margin:18px 0 10px; }
  .chart-bars { display:flex; flex-direction:column; gap:10px; margin-top:14px; }
  .io-chart { margin-top:16px; }
  .chart-row { display:grid; grid-template-columns:84px 1fr 74px; align-items:center; gap:10px; }
  .chart-bars-wide .chart-row { grid-template-columns:126px 1fr 74px; }
  .chart-label { font-size:.82rem; color:#6b7280; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chart-track { height:10px; border-radius:999px; background:#f0f0f3; overflow:hidden; }
  .chart-fill { height:100%; border-radius:999px; background:#2b6e63; }
  .chart-fill.in { background:#16a34a; }
  .chart-fill.out { background:#ef4444; }
  .chart-value { text-align:right; font-family:ui-monospace,'SF Mono',Consolas,monospace; font-variant-numeric:tabular-nums; font-size:.82rem; color:#1a1f3c; }
  .results-grid { margin-bottom:18px; }
  .rem-form select { flex:1 1 110px; }
  .del:hover { color:#ef4444; }
  .add-form { padding-top:10px; margin-top:8px; border-top:1px dashed #e5e7eb; }
  .add-form select { flex:1 1 120px; }
  .assignee-block { margin-bottom:14px; }
  .assignee-block:last-child { margin-bottom:0; }
  .assignee-block h4 { margin:0 0 4px; font-size:.85rem; color:#2b6e63; }
  .menu-form { display:flex; flex-direction:column; gap:10px; }
  .menu-form label { display:flex; flex-direction:column; gap:4px; font-size:.78rem; color:#9aa0b4; }
  .menu-form input { border:1px solid var(--border); border-radius:var(--radius-sm); padding:8px 10px; font-size:.9rem; color:var(--ink); }
  .menu-form button { align-self:flex-start; border:none; background:var(--accent); color:#fff; border-radius:var(--radius-sm); padding:9px 18px; font-size:.88rem; font-weight:600; cursor:pointer; transition:background .15s ease; }
  .menu-form button:hover { background:var(--accent-dark); }
  .field { display:flex; flex-direction:column; gap:4px; font-size:.78rem; color:#9aa0b4; margin-bottom:12px; }
  .field input, .field select { padding:9px 10px; font-size:.92rem; color:#1a1f3c; border:1px solid #e5e7eb; border-radius:8px; }
  .chk { display:flex; align-items:center; gap:8px; font-size:.88rem; margin-bottom:14px; }
  .btn-row { display:flex; gap:10px; margin-top:6px; }
  .btn-row button, .btn-secondary { border:none; background:var(--accent); color:#fff; border-radius:var(--radius-sm); padding:9px 16px; font-size:.88rem; font-weight:600; cursor:pointer; text-decoration:none; display:inline-block; transition:background .15s ease, transform .1s ease; }
  .btn-row button:hover, .btn-secondary:hover { background:var(--accent-dark); }
  .btn-row button:active, .btn-secondary:active { transform:scale(.98); }
  .btn-secondary { background:var(--accent-tint); color:var(--accent); }
  .btn-secondary:hover { background:var(--accent-tint-2); }
  .danger-form { margin-top:18px; padding-top:14px; border-top:1px solid #f0f0f3; }
  .danger { border:none; background:#fee2e2; color:#b91c1c; border-radius:var(--radius-sm); padding:9px 14px; font-size:.85rem; font-weight:600; cursor:pointer; transition:background .15s ease; }
  .danger:hover { background:#fecaca; }
  footer { text-align:center; color:var(--ink-faint); font-size:.72rem; padding:22px; }
`;

const SHARED_SCRIPT = `
document.querySelectorAll('[data-toggle]').forEach(function (el) {
  el.addEventListener('change', function () {
    var li = el.closest('li');
    el.disabled = true;
    fetch(el.dataset.toggle, { method: 'POST' })
      .then(function (r) { if (!r.ok) throw new Error('fail'); if (li) li.classList.toggle('done', el.checked); })
      .catch(function () { el.checked = !el.checked; })
      .finally(function () { el.disabled = false; });
  });
});
document.querySelectorAll('[data-del]').forEach(function (el) {
  el.addEventListener('click', function () {
    if (!confirm('¿Borrar esto?')) return;
    var li = el.closest('li');
    fetch(el.dataset.del, { method: 'POST' })
      .then(function (r) { if (r.ok && li) li.remove(); })
      .catch(function () {});
  });
});
`;
