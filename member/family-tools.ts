// member/family-tools.ts — tools de la familia La Cruz: perfil de cada
// integrante, enlaces de invitación y tareas de la casa. Vive en member/, así
// que forjabot update NUNCA la toca. Se cargan desde member/tools.local.ts.
import { tool } from "ai";
import { z } from "zod";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { MemberToolCtx } from "../src/tools/member";
import { resolveProvider } from "../src/llm/provider";
import {
  db,
  newId,
  todayInTZ,
  getSenderChannelUserId,
  findMemberByChatId,
  findMemberByName,
  listMembers,
  countMembers,
  ageFromBirthdate,
  bmiInfo,
  getBotUsername,
  isChorePending,
  zonedDateTimeToUtcMs,
  formatDateTimeInTZ,
  sendTelegramMessage,
  fundBalance,
  allocateIncomeToFunds,
  loanPayoff,
  INVITE_TTL_MS,
  MAX_FULL_ACCESS,
  type FamilyMember,
  type Chore,
  type Reminder,
  type Transaction,
  type Budget,
  type FinanceFund,
  type Debt,
} from "./family-lib";

async function requireFullAccessSender(
  ctx: MemberToolCtx,
): Promise<{ ok: true; member: FamilyMember } | { ok: false; error: string }> {
  const d = db(ctx.env);
  const chatId = await getSenderChannelUserId(d, ctx.getConversationId());
  if (!chatId) return { ok: false, error: "No pude identificar quién escribe." };
  const member = await findMemberByChatId(d, chatId);
  if (!member || member.access_level !== "full") {
    return {
      ok: false,
      error:
        "Quien escribe no tiene acceso completo de la familia. Solo papá, mamá o la hija mayor pueden hacer esto.",
    };
  }
  return { ok: true, member };
}

/** Para gestionar la ESTRUCTURA del hogar (invitar, revocar, cambiar niveles) — no basta con acceso completo, hace falta ser admin. */
async function requireAdminSender(
  ctx: MemberToolCtx,
): Promise<{ ok: true; member: FamilyMember } | { ok: false; error: string }> {
  const check = await requireFullAccessSender(ctx);
  if (!check.ok) return check;
  if (check.member.permission_tier !== "admin") {
    return { ok: false, error: "Solo un administrador del hogar puede hacer esto — pídeselo a quien tenga ese nivel." };
  }
  return check;
}

/** viewer=null (no se pudo identificar quién pregunta) se trata como sin privilegios — más seguro que asumir acceso. */
function canSeeHealthOf(m: FamilyMember, viewer: FamilyMember | null): boolean {
  if (!m.health_private) return true;
  if (!viewer) return false;
  return viewer.id === m.id || viewer.permission_tier === "admin";
}

function memberSummary(m: FamilyMember, viewer: FamilyMember | null) {
  const canSeeHealth = canSeeHealthOf(m, viewer);
  const edad = ageFromBirthdate(m.birthdate);
  const bmi = canSeeHealth ? bmiInfo(m.weight_kg, m.height_cm) : null;
  return {
    nombre: m.name,
    rol: m.role,
    accesoCompleto: m.access_level === "full",
    nivelPermiso: m.permission_tier,
    conectado: m.telegram_chat_id != null,
    fechaNacimiento: m.birthdate,
    edad,
    pesoKg: canSeeHealth ? m.weight_kg : null,
    estaturaCm: canSeeHealth ? m.height_cm : null,
    tallaRopa: m.clothing_size,
    nacionalidad: m.nationality,
    preferenciasComida: m.food_preferences,
    alergias: canSeeHealth ? m.allergies : null,
    objetivoNutricional: canSeeHealth ? m.nutrition_goal : null,
    intereses: m.interests,
    imc: bmi?.bmi ?? null,
    categoriaImc: bmi?.category ?? null,
    datosSaludPrivados: !!m.health_private,
    ...(m.health_private && !canSeeHealth ? { nota: "Esta persona mantiene sus datos de salud en privado." } : {}),
  };
}

export function familyTools(ctx: MemberToolCtx): Record<string, unknown> {
  const d = db(ctx.env);

  const registrarIntegranteFamilia = tool({
    description:
      "Registra a un nuevo integrante de la familia La Cruz (perfil). Si la familia todavía no tiene a nadie registrado, la primera persona que escribe queda registrada automáticamente como administrador (acceso completo) sin pedir permiso. Después de eso, solo alguien con acceso completo (papá, mamá o hija mayor) puede registrar a los demás.",
    inputSchema: z.object({
      nombre: z.string().describe("Nombre del integrante, ej. 'Ara' o 'Adiel'"),
      rol: z.string().describe("papá | mamá | hijo | hija | hija mayor | hijo menor…"),
      accesoCompleto: z
        .boolean()
        .describe(
          "true si va a chatear directo con el bot (adultos, hija mayor). false si es un menor cuyo perfil llevan los adultos.",
        ),
      fechaNacimiento: z.string().optional().describe("YYYY-MM-DD"),
      pesoKg: z.number().optional(),
      estaturaCm: z.number().optional(),
      tallaRopa: z.string().optional(),
      nacionalidad: z.string().optional(),
      alergias: z.string().optional().describe("Alergias o restricciones alimentarias, ej. 'lactosa, frutos secos'"),
      objetivoNutricional: z
        .enum(["bajar_peso", "mantener", "ganar_musculo", "comer_mas_sano", "alto_proteina", "ayuno_intermitente"])
        .optional()
        .describe("Objetivo para el menú/ejercicio de este integrante"),
      nivelFisico: z.enum(["bajo", "medio", "alto"]).optional().describe("Nivel actual de condición física"),
      tiempoDisponible: z.string().optional().describe("ej. '3 veces por semana, 30 min'"),
      lesiones: z.string().optional().describe("Lesiones o limitaciones físicas a respetar en el plan de ejercicio"),
      dondeEjercicio: z.string().optional().describe("Dónde entrena y con qué equipo cuenta, ej. 'gimnasio con máquinas y pesas libres', 'casa sin equipo', 'casa con mancuernas y banda elástica', 'parque/aire libre'"),
      intereses: z.string().optional().describe("Gustos/intereses (útil sobre todo para niños), ej. 'dinosaurios, dibujar, fútbol'"),
    }),
    execute: async (input) => {
      const total = await countMembers(d);
      const senderChatId = await getSenderChannelUserId(d, ctx.getConversationId());

      if (total > 0) {
        // Ya hay familia: agregar acceso completo es estructural (solo admin);
        // agregar un perfil gestionado (niño) lo puede hacer cualquier adulto.
        const check = input.accesoCompleto ? await requireAdminSender(ctx) : await requireFullAccessSender(ctx);
        if (!check.ok) return { error: check.error };
      }

      if (input.accesoCompleto) {
        const fullCount = await d.first<{ n: number }>("SELECT COUNT(*) as n FROM family_members WHERE access_level = 'full'");
        if ((fullCount?.n ?? 0) >= MAX_FULL_ACCESS) {
          return { error: `Ya hay ${MAX_FULL_ACCESS} integrantes con acceso completo — es el máximo por hogar. Puedes registrar a ${input.nombre} con accesoCompleto=false (perfil gestionado) en su lugar.` };
        }
      }

      const existing = await findMemberByName(d, input.nombre);
      if (existing)
        return {
          error: `Ya existe un integrante que coincide con "${input.nombre}" (registrado como "${existing.name}"). No crees uno nuevo — usa actualizarDatosIntegrante con nombre="${existing.name}" para completar o corregir sus datos.`,
        };

      const now = Date.now();
      const id = newId();
      // Bootstrap: si es el primer integrante de la familia y accesoCompleto,
      // lo conectamos directo con el chat_id de quien está escribiendo, y queda
      // como admin (alguien tiene que serlo desde el día uno).
      const chatId = total === 0 && input.accesoCompleto ? senderChatId : null;
      const permissionTier = input.accesoCompleto ? (total === 0 ? "admin" : "adult") : null;

      await d.run(
        `INSERT INTO family_members
          (id, name, role, access_level, telegram_chat_id, birthdate, weight_kg, height_cm, clothing_size, nationality, allergies, nutrition_goal, fitness_level, time_available, injuries, exercise_setting, interests, permission_tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.nombre,
          input.rol,
          input.accesoCompleto ? "full" : "managed",
          chatId,
          input.fechaNacimiento ?? null,
          input.pesoKg ?? null,
          input.estaturaCm ?? null,
          input.tallaRopa ?? null,
          input.nacionalidad ?? null,
          input.alergias ?? null,
          input.objetivoNutricional ?? null,
          input.nivelFisico ?? null,
          input.tiempoDisponible ?? null,
          input.lesiones ?? null,
          input.dondeEjercicio ?? null,
          input.intereses ?? null,
          permissionTier,
          now,
          now,
        ],
      );
      return {
        ok: true,
        id,
        conectado: chatId != null,
        mensaje:
          chatId != null
            ? `${input.nombre} quedó registrado y conectado.`
            : input.accesoCompleto
              ? `${input.nombre} quedó registrado con acceso completo. Génerale un enlace de invitación con generarEnlaceInvitacion para que se conecte desde su propio Telegram.`
              : `${input.nombre} quedó registrado. Como no tiene acceso directo, quien tenga acceso completo puede actualizar sus datos cuando haga falta.`,
      };
    },
  });

  const generarEnlaceInvitacion = tool({
    description:
      "Genera un enlace de invitación de un solo uso para que un integrante con accesoCompleto (ya registrado, pero sin conectar todavía) se una al bot desde su propio Telegram.",
    inputSchema: z.object({
      nombre: z.string().describe("Nombre exacto del integrante ya registrado"),
    }),
    execute: async ({ nombre }) => {
      const check = await requireAdminSender(ctx);
      if (!check.ok) return { error: check.error };

      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };
      if (member.access_level !== "full")
        return { error: `${nombre} no tiene acceso completo — no necesita conectarse por su cuenta.` };
      if (member.telegram_chat_id)
        return { error: `${nombre} ya está conectado.` };

      const username = await getBotUsername(ctx.env);
      if (!username) return { error: "No pude obtener el username del bot en Telegram." };

      const token = newId().replace(/-/g, "").slice(0, 24);
      const now = Date.now();
      await d.run(
        `INSERT INTO family_invites (token, member_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [token, member.id, check.member.id, now, now + INVITE_TTL_MS],
      );

      return {
        ok: true,
        enlace: `https://t.me/${username}?start=${token}`,
        mensaje: `Mándale este enlace a ${nombre} por su cuenta — vale por 7 días. Al abrirlo en Telegram y tocar "Iniciar", queda conectado automáticamente.`,
      };
    },
  });

  const generarEnlaceAccesoWeb = tool({
    description:
      "Genera un enlace de un solo uso para que un integrante con acceso completo entre a la página web de la familia (/familia) con su PROPIA sesión guardada en su navegador — no necesita saber ninguna contraseña. Úsalo cuando pidan 'dame acceso a la web', 'quiero mi propio usuario', etc.",
    inputSchema: z.object({ nombre: z.string().describe("Nombre exacto del integrante, con acceso completo") }),
    execute: async ({ nombre }) => {
      const check = await requireAdminSender(ctx);
      if (!check.ok) return { error: check.error };

      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };
      if (member.access_level !== "full") return { error: `${nombre} no tiene acceso completo.` };

      const token = newId().replace(/-/g, "") + newId().replace(/-/g, "");
      await d.run("INSERT INTO family_web_invites (token, member_id, created_at) VALUES (?, ?, ?)", [token, member.id, Date.now()]);
      const base = ctx.env.DASHBOARD_BASE_URL || "";

      return {
        ok: true,
        enlace: `${base}/familia/entrar/${token}`,
        mensaje: `Mándale este enlace a ${nombre} — al abrirlo en su navegador entra directo, con su propia sesión guardada ahí.`,
      };
    },
  });

  const actualizarDatosIntegrante = tool({
    description:
      "Actualiza el perfil de un integrante ya registrado (peso, estatura, talla de ropa, fecha de nacimiento, nacionalidad, preferencias de comida). Cualquiera con acceso completo puede actualizar a cualquier integrante, incluido a sí mismo.",
    inputSchema: z.object({
      nombre: z.string(),
      fechaNacimiento: z.string().optional().describe("YYYY-MM-DD"),
      pesoKg: z.number().optional(),
      estaturaCm: z.number().optional(),
      tallaRopa: z.string().optional(),
      nacionalidad: z.string().optional(),
      preferenciasComida: z.string().optional().describe("Platillos o gustos de comida"),
      alergias: z.string().optional().describe("Alergias o restricciones alimentarias"),
      objetivoNutricional: z.enum(["bajar_peso", "mantener", "ganar_musculo", "comer_mas_sano", "alto_proteina", "ayuno_intermitente"]).optional(),
      nivelFisico: z.enum(["bajo", "medio", "alto"]).optional(),
      tiempoDisponible: z.string().optional().describe("ej. '3 veces por semana, 30 min'"),
      lesiones: z.string().optional(),
      dondeEjercicio: z.string().optional().describe("Dónde entrena y con qué equipo cuenta, ej. 'gimnasio con máquinas y pesas libres', 'casa sin equipo', 'casa con mancuernas y banda elástica', 'parque/aire libre'"),
      intereses: z.string().optional().describe("Gustos/intereses (útil sobre todo para niños)"),
      datosSaludPrivados: z
        .boolean()
        .optional()
        .describe("true = peso/estatura/IMC/alergias/objetivo/nivel físico/lesiones solo los ve esta persona y los admins"),
      nivelPermiso: z.enum(["admin", "adult"]).optional().describe("Solo un admin puede cambiar el nivel de otro integrante"),
    }),
    execute: async ({ nombre, ...fields }) => {
      const check = await requireFullAccessSender(ctx);
      if (!check.ok) return { error: check.error };

      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };

      if (fields.nivelPermiso !== undefined && check.member.permission_tier !== "admin") {
        return { error: "Solo un administrador del hogar puede cambiar el nivel de permiso de alguien." };
      }
      if (fields.datosSaludPrivados !== undefined && check.member.id !== member.id && check.member.permission_tier !== "admin") {
        return { error: `Solo ${member.name} o un administrador pueden cambiar la privacidad de sus datos de salud.` };
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const map: Record<string, unknown> = {
        birthdate: fields.fechaNacimiento,
        weight_kg: fields.pesoKg,
        height_cm: fields.estaturaCm,
        clothing_size: fields.tallaRopa,
        nationality: fields.nacionalidad,
        food_preferences: fields.preferenciasComida,
        allergies: fields.alergias,
        nutrition_goal: fields.objetivoNutricional,
        fitness_level: fields.nivelFisico,
        time_available: fields.tiempoDisponible,
        injuries: fields.lesiones,
        exercise_setting: fields.dondeEjercicio,
        interests: fields.intereses,
        health_private: fields.datosSaludPrivados === undefined ? undefined : fields.datosSaludPrivados ? 1 : 0,
        permission_tier: fields.nivelPermiso,
      };
      for (const [col, val] of Object.entries(map)) {
        if (val !== undefined) {
          sets.push(`${col} = ?`);
          params.push(val);
        }
      }
      if (sets.length === 0) return { error: "No mandaste ningún dato para actualizar." };
      sets.push("updated_at = ?");
      params.push(Date.now(), member.id);

      await d.run(`UPDATE family_members SET ${sets.join(", ")} WHERE id = ?`, params);
      return { ok: true, mensaje: `Datos de ${nombre} actualizados.` };
    },
  });

  const consultarIntegrante = tool({
    description:
      "Consulta el perfil completo de un integrante (edad calculada, IMC calculado, talla, nacionalidad, preferencias de comida). Útil antes de sugerir alimentación o actividad física.",
    inputSchema: z.object({ nombre: z.string() }),
    execute: async ({ nombre }) => {
      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };
      const viewerChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const viewer = viewerChatId ? await findMemberByChatId(d, viewerChatId) : null;
      return memberSummary(member, viewer);
    },
  });

  const listarFamilia = tool({
    description: "Lista a todos los integrantes registrados de la familia con su perfil resumido.",
    inputSchema: z.object({}),
    execute: async () => {
      const members = await listMembers(d);
      const viewerChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const viewer = viewerChatId ? await findMemberByChatId(d, viewerChatId) : null;
      return { integrantes: members.map((m) => memberSummary(m, viewer)) };
    },
  });

  const insertChore = async (input: {
    titulo: string;
    asignadoA?: string;
    fechaLimite?: string;
    tipo?: "diaria" | "puntual";
    categoria?: "tarea" | "ejercicio";
  }): Promise<{ error: string } | { ok: true; id: string }> => {
    let assignedId: string | null = null;
    if (input.asignadoA) {
      const member = await findMemberByName(d, input.asignadoA);
      if (!member) return { error: `No encontré a ningún integrante llamado ${input.asignadoA}.` };
      assignedId = member.id;
    }
    const now = Date.now();
    const id = newId();
    await d.run(
      `INSERT INTO household_chores (id, title, assigned_to, status, due_date, kind, category, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [id, input.titulo, assignedId, input.fechaLimite ?? null, input.tipo ?? "puntual", input.categoria ?? "tarea", now, now],
    );
    return { ok: true, id };
  };

  const registrarTareaCasa = tool({
    description:
      "Registra UNA tarea de la casa o rutina de ejercicio, opcionalmente asignada a un integrante. 'diaria' vuelve a aparecer pendiente cada día aunque se haya marcado hecha; 'puntual' es de una sola vez. Para VARIAS de una vez (ej. un plan de ejercicio semanal) usa registrarVariasTareas — evita cortar el turno a mitad de camino.",
    inputSchema: z.object({
      titulo: z.string(),
      asignadoA: z.string().optional().describe("Nombre del integrante responsable"),
      fechaLimite: z.string().optional().describe("YYYY-MM-DD, solo para tareas puntuales"),
      tipo: z.enum(["diaria", "puntual"]).optional().default("puntual"),
      categoria: z.enum(["tarea", "ejercicio"]).optional().default("tarea"),
    }),
    execute: async (input) => {
      const result = await insertChore(input);
      if ("error" in result) return result;
      return { ok: true, id: result.id, mensaje: `${input.categoria === "ejercicio" ? "Rutina" : "Tarea"} "${input.titulo}" registrada (${input.tipo ?? "puntual"}).` };
    },
  });

  const registrarVariasTareas = tool({
    description:
      "Registra VARIAS tareas o sesiones de ejercicio de una vez EN UNA SOLA LLAMADA (ej. las 5 sesiones de un plan semanal) — úsala siempre que vayas a crear más de una, en vez de llamar registrarTareaCasa varias veces seguidas.",
    inputSchema: z.object({
      tareas: z
        .array(
          z.object({
            titulo: z.string(),
            asignadoA: z.string().optional(),
            fechaLimite: z.string().optional().describe("YYYY-MM-DD"),
            tipo: z.enum(["diaria", "puntual"]).optional().default("puntual"),
            categoria: z.enum(["tarea", "ejercicio"]).optional().default("tarea"),
          }),
        )
        .min(1)
        .max(30),
    }),
    execute: async ({ tareas }) => {
      let ok = 0;
      const errores: string[] = [];
      for (const t of tareas) {
        const result = await insertChore(t);
        if ("error" in result) errores.push(result.error);
        else ok++;
      }
      return { ok: true, mensaje: `${ok} de ${tareas.length} registradas.`, errores: errores.length ? errores : undefined };
    },
  });

  const listarTareasCasa = tool({
    description:
      "Lista tareas de la casa y/o rutinas de ejercicio, con filtros opcionales de tipo (diaria/puntual), categoría (tarea/ejercicio) y estado.",
    inputSchema: z.object({
      soloPendientes: z.boolean().optional().default(true),
      tipo: z.enum(["diaria", "puntual"]).optional(),
      categoria: z.enum(["tarea", "ejercicio"]).optional(),
      asignadoA: z.string().optional().describe("Filtrar solo lo asignado a este integrante"),
    }),
    execute: async ({ soloPendientes, tipo, categoria, asignadoA }) => {
      const rows = await d.all<Chore>(
        "SELECT id, title, assigned_to, status, due_date, kind, category, created_at, updated_at FROM household_chores ORDER BY created_at ASC",
      );
      const members = await listMembers(d);
      const nameById = new Map(members.map((m) => [m.id, m.name]));
      const today = todayInTZ(ctx.env);

      let filtered = rows;
      if (soloPendientes) filtered = filtered.filter((r) => isChorePending(r, ctx.env, today));
      if (tipo) filtered = filtered.filter((r) => r.kind === tipo);
      if (categoria) filtered = filtered.filter((r) => r.category === categoria);
      if (asignadoA) {
        const member = await findMemberByName(d, asignadoA);
        if (!member) return { error: `No encontré a ningún integrante llamado ${asignadoA}.` };
        filtered = filtered.filter((r) => r.assigned_to === member.id);
      }

      return {
        tareas: filtered.map((r) => ({
          id: r.id,
          titulo: r.title,
          asignadoA: r.assigned_to ? (nameById.get(r.assigned_to) ?? null) : null,
          estado: isChorePending(r, ctx.env, today) ? "pending" : r.status,
          tipo: r.kind,
          categoria: r.category,
          fechaLimite: r.due_date,
        })),
      };
    },
  });

  const completarTareaCasa = tool({
    description: "Marca una tarea de la casa o rutina de ejercicio como hecha por hoy, por su título (o parte de él).",
    inputSchema: z.object({ titulo: z.string() }),
    execute: async ({ titulo }) => {
      const today = todayInTZ(ctx.env);
      const candidates = await d.all<Chore>(
        "SELECT id, title, assigned_to, status, due_date, kind, category, created_at, updated_at FROM household_chores WHERE title LIKE ? ORDER BY created_at ASC",
        [`%${titulo}%`],
      );
      const match = candidates.find((c) => isChorePending(c, ctx.env, today));
      if (!match) return { error: `No encontré una tarea pendiente que coincida con "${titulo}".` };
      await d.run("UPDATE household_chores SET status = 'done', updated_at = ? WHERE id = ?", [
        Date.now(),
        match.id,
      ]);
      return { ok: true, mensaje: `"${match.title}" marcada como hecha.` };
    },
  });

  const insertShoppingItem = async (nombre: string, categoria: string | null, cantidad: string | null, notaConservacion: string | null, senderId: string | null): Promise<{ ok: true } | { error: string }> => {
    const existing = await d.first<{ id: string }>(
      "SELECT id FROM shopping_items WHERE status = 'pending' AND lower(name) = lower(?)",
      [nombre],
    );
    if (existing) return { error: `"${nombre}" ya está en la lista.` };
    const now = Date.now();
    await d.run(
      `INSERT INTO shopping_items (id, name, category, quantity, prep_note, status, added_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [newId(), nombre, categoria, cantidad, notaConservacion, senderId, now, now],
    );
    return { ok: true };
  };

  const agregarProductoCompra = tool({
    description: "Agrega un producto a la lista de la compra de la casa.",
    inputSchema: z.object({
      nombre: z.string(),
      categoria: z.string().optional().describe("ej. 'lácteos', 'limpieza', 'frutas'"),
      cantidad: z
        .string()
        .optional()
        .describe(
          "Cuánto comprar — calcúlalo con la receta/menú de la semana y cuántas personas son (consultarMenuDia + consultarPerfilNutricionalFamilia), ej. '1.2 kg', '6 unidades', '2 litros'. No lo dejes vacío si ya sabes para cuántas porciones es.",
        ),
      notaConservacion: z
        .string()
        .optional()
        .describe(
          "Si es carne o verdura que no se va a usar toda de inmediato, indica cómo conservarla para evitar que se dañe, ej. 'picar y congelar en porciones de 2 personas', 'lavar, picar y congelar en bolsas de 250g'.",
        ),
    }),
    execute: async ({ nombre, categoria, cantidad, notaConservacion }) => {
      const senderChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const sender = senderChatId ? await findMemberByChatId(d, senderChatId) : null;
      const result = await insertShoppingItem(nombre, categoria ?? null, cantidad ?? null, notaConservacion ?? null, sender?.id ?? null);
      if ("error" in result) return result;
      return { ok: true, mensaje: `"${nombre}"${cantidad ? ` (${cantidad})` : ""} agregado a la lista de la compra.` };
    },
  });

  const agregarVariosProductosCompra = tool({
    description:
      "Agrega VARIOS productos a la lista de la compra en una sola llamada — úsala SIEMPRE que armes la lista de compras de la semana a partir del menú (varios productos de un jalón), en vez de llamar agregarProductoCompra varias veces seguidas (eso corta la respuesta a la mitad).",
    inputSchema: z.object({
      productos: z
        .array(
          z.object({
            nombre: z.string(),
            categoria: z.string().optional(),
            cantidad: z.string().optional().describe("Calculada según receta/menú y número de personas, ej. '1.2 kg', '6 unidades'"),
            notaConservacion: z.string().optional().describe("Cómo picar/congelar carnes o verduras que no se usarán todas de inmediato"),
          }),
        )
        .min(1),
    }),
    execute: async ({ productos }) => {
      const senderChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const sender = senderChatId ? await findMemberByChatId(d, senderChatId) : null;
      const agregados: string[] = [];
      const repetidos: string[] = [];
      for (const p of productos) {
        const result = await insertShoppingItem(p.nombre, p.categoria ?? null, p.cantidad ?? null, p.notaConservacion ?? null, sender?.id ?? null);
        if ("error" in result) repetidos.push(p.nombre);
        else agregados.push(p.nombre);
      }
      return { ok: true, agregados, repetidos: repetidos.length ? repetidos : undefined };
    },
  });

  const listarListaCompra = tool({
    description: "Lista la lista de la compra: lo que falta comprar y, si se pide, también lo ya comprado.",
    inputSchema: z.object({ incluirComprados: z.boolean().optional().default(false) }),
    execute: async ({ incluirComprados }) => {
      const rows = await d.all<{ id: string; name: string; category: string | null; quantity: string | null; prep_note: string | null; status: string }>(
        incluirComprados
          ? "SELECT id, name, category, quantity, prep_note, status FROM shopping_items ORDER BY status ASC, created_at ASC"
          : "SELECT id, name, category, quantity, prep_note, status FROM shopping_items WHERE status = 'pending' ORDER BY created_at ASC",
      );
      return {
        productos: rows.map((r) => ({
          id: r.id,
          nombre: r.name,
          categoria: r.category,
          cantidad: r.quantity,
          notaConservacion: r.prep_note,
          comprado: r.status === "bought",
        })),
      };
    },
  });

  const marcarProductoComprado = tool({
    description: "Marca uno o varios productos de la lista de la compra como ya comprados, por nombre (o parte de él).",
    inputSchema: z.object({ nombre: z.string() }),
    execute: async ({ nombre }) => {
      const row = await d.first<{ id: string; name: string }>(
        "SELECT id, name FROM shopping_items WHERE status = 'pending' AND name LIKE ? ORDER BY created_at ASC LIMIT 1",
        [`%${nombre}%`],
      );
      if (!row) return { error: `No encontré "${nombre}" pendiente en la lista.` };
      await d.run("UPDATE shopping_items SET status = 'bought', updated_at = ? WHERE id = ?", [Date.now(), row.id]);
      return { ok: true, mensaje: `"${row.name}" marcado como comprado.` };
    },
  });

  interface MealDayInput {
    fecha?: string;
    desayuno?: string;
    desayunoReceta?: string;
    comida?: string;
    comidaReceta?: string;
    cena?: string;
    cenaReceta?: string;
    notas?: string;
  }

  const upsertMealDay = async ({ fecha, desayuno, desayunoReceta, comida, comidaReceta, cena, cenaReceta, notas }: MealDayInput): Promise<string> => {
    const date = fecha ?? todayInTZ(ctx.env);
    const existing = await d.first<{ date: string }>("SELECT date FROM meal_plan WHERE date = ?", [date]);
    const now = Date.now();
    const map: Record<string, unknown> = {
      breakfast: desayuno,
      breakfast_recipe: desayunoReceta,
      lunch: comida,
      lunch_recipe: comidaReceta,
      dinner: cena,
      dinner_recipe: cenaReceta,
      notes: notas,
    };
    if (existing) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [col, val] of Object.entries(map)) {
        if (val !== undefined) {
          sets.push(`${col} = ?`);
          params.push(val);
        }
      }
      if (sets.length) {
        sets.push("updated_at = ?");
        params.push(now, date);
        await d.run(`UPDATE meal_plan SET ${sets.join(", ")} WHERE date = ?`, params);
      }
    } else {
      await d.run(
        `INSERT INTO meal_plan (date, breakfast, breakfast_recipe, lunch, lunch_recipe, dinner, dinner_recipe, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [date, desayuno ?? null, desayunoReceta ?? null, comida ?? null, comidaReceta ?? null, cena ?? null, cenaReceta ?? null, notas ?? null, now, now],
      );
    }
    return date;
  };

  const definirMenuDia = tool({
    description: "Define o actualiza el menú de UN SOLO día (desayuno/comida/cena), con ingredientes y receta opcionales. Si no se da la fecha, es la de hoy. Para el menú de la SEMANA completa usa definirMenuSemanal en vez de llamar esta 7 veces — ahorra muchas vueltas y evita que el turno se corte.",
    inputSchema: z.object({
      fecha: z.string().optional().describe("YYYY-MM-DD, por default hoy"),
      desayuno: z.string().optional().describe("Nombre corto del plato"),
      desayunoReceta: z.string().optional().describe("Ingredientes exactos + receta paso a paso del desayuno"),
      comida: z.string().optional().describe("Nombre corto del plato"),
      comidaReceta: z.string().optional().describe("Ingredientes exactos + receta paso a paso de la comida"),
      cena: z.string().optional().describe("Nombre corto del plato"),
      cenaReceta: z.string().optional().describe("Ingredientes exactos + receta paso a paso de la cena"),
      notas: z.string().optional(),
    }),
    execute: async (input) => {
      const date = await upsertMealDay(input);
      return { ok: true, mensaje: `Menú del ${date} guardado.` };
    },
  });

  const definirMenuSemanal = tool({
    description:
      "Guarda el menú de VARIOS días (ej. la semana completa) EN UNA SOLA LLAMADA — úsala siempre que armes más de un día de menú, en vez de llamar definirMenuDia repetidas veces (eso puede cortar la respuesta a mitad de camino). Escribe primero todos los platos y recetas, y mándalos todos juntos aquí.",
    inputSchema: z.object({
      dias: z
        .array(
          z.object({
            fecha: z.string().describe("YYYY-MM-DD"),
            desayuno: z.string().optional(),
            desayunoReceta: z.string().optional(),
            comida: z.string().optional(),
            comidaReceta: z.string().optional(),
            cena: z.string().optional(),
            cenaReceta: z.string().optional(),
          }),
        )
        .min(1)
        .max(14),
    }),
    execute: async ({ dias }) => {
      const fechas: string[] = [];
      for (const dia of dias) fechas.push(await upsertMealDay(dia));
      return { ok: true, mensaje: `Menú guardado para ${fechas.length} día(s): ${fechas.join(", ")}.` };
    },
  });

  const consultarMenuDia = tool({
    description: "Consulta el menú de un día, con receta si la tiene. Si no se da la fecha, es la de hoy.",
    inputSchema: z.object({ fecha: z.string().optional().describe("YYYY-MM-DD, por default hoy") }),
    execute: async ({ fecha }) => {
      const date = fecha ?? todayInTZ(ctx.env);
      const row = await d.first<{
        breakfast: string | null;
        breakfast_recipe: string | null;
        lunch: string | null;
        lunch_recipe: string | null;
        dinner: string | null;
        dinner_recipe: string | null;
        notes: string | null;
      }>(
        "SELECT breakfast, breakfast_recipe, lunch, lunch_recipe, dinner, dinner_recipe, notes FROM meal_plan WHERE date = ?",
        [date],
      );
      if (!row) return { fecha: date, definido: false };
      return {
        fecha: date,
        definido: true,
        desayuno: row.breakfast,
        desayunoReceta: row.breakfast_recipe,
        comida: row.lunch,
        comidaReceta: row.lunch_recipe,
        cena: row.dinner,
        cenaReceta: row.dinner_recipe,
        notas: row.notes,
      };
    },
  });

  const consultarPerfilNutricionalFamilia = tool({
    description:
      "Trae el perfil nutricional de toda la familia (edad, alergias, objetivo, gustos de comida de cada quien) — úsalo antes de armar un menú semanal para que sea de verdad personalizado, no genérico.",
    inputSchema: z.object({}),
    execute: async () => {
      const members = await listMembers(d);
      return {
        integrantes: members.map((m) => ({
          nombre: m.name,
          edad: ageFromBirthdate(m.birthdate),
          alergias: m.allergies,
          objetivoNutricional: m.nutrition_goal,
          preferenciasComida: m.food_preferences,
          nacionalidad: m.nationality,
        })),
      };
    },
  });

  const consultarPerfilFisicoFamilia = tool({
    description:
      "Trae el perfil físico de toda la familia (edad, IMC, nivel actual, tiempo disponible, lesiones/limitaciones, objetivo, dónde entrena y con qué equipo) — úsalo SIEMPRE antes de armar un plan de ejercicio para que sea de verdad personalizado, no genérico. Si a alguien le falta el objetivo o el lugar/equipo, pregúntaselo antes de proponer la rutina — no asumas.",
    inputSchema: z.object({}),
    execute: async () => {
      const members = await listMembers(d);
      return {
        integrantes: members.map((m) => {
          const bmi = bmiInfo(m.weight_kg, m.height_cm);
          return {
            nombre: m.name,
            edad: ageFromBirthdate(m.birthdate),
            imc: bmi?.bmi ?? null,
            categoriaImc: bmi?.category ?? null,
            nivelFisico: m.fitness_level,
            tiempoDisponible: m.time_available,
            lesiones: m.injuries,
            dondeEjercicio: m.exercise_setting,
            objetivo: m.nutrition_goal,
          };
        }),
      };
    },
  });

  const guardarPlanEjercicio = tool({
    description:
      "Guarda (o reemplaza) el plan de ejercicio semanal narrativo de un integrante — texto libre con qué hacer cada día. Además de esto, crea las sesiones como tareas con registrarTareaCasa (categoria='ejercicio') para que se puedan marcar como hechas y dar seguimiento.",
    inputSchema: z.object({
      nombre: z.string(),
      plan: z.string().describe("Plan semanal completo, día por día, adaptado al nivel/tiempo/lesiones de la persona"),
    }),
    execute: async ({ nombre, plan }) => {
      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };
      const now = Date.now();
      await d.run(
        `INSERT INTO exercise_plan (member_id, plan_text, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(member_id) DO UPDATE SET plan_text = excluded.plan_text, updated_at = excluded.updated_at`,
        [member.id, plan, now, now],
      );
      return { ok: true, mensaje: `Plan de ejercicio de ${nombre} guardado. Ahora crea las sesiones de la semana con registrarTareaCasa (categoria='ejercicio', asignadoA='${nombre}') para poder marcarlas como hechas.` };
    },
  });

  const consultarPlanEjercicio = tool({
    description: "Consulta el plan de ejercicio guardado de un integrante.",
    inputSchema: z.object({ nombre: z.string() }),
    execute: async ({ nombre }) => {
      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };
      const row = await d.first<{ plan_text: string }>("SELECT plan_text FROM exercise_plan WHERE member_id = ?", [member.id]);
      if (!row) return { definido: false };
      return { definido: true, plan: row.plan_text };
    },
  });

  const guardarActividadFamiliar = tool({
    description:
      "Guarda una idea de actividad familiar (sugerencia nueva, o una ya probada que funcionó bien). Úsala cuando sugieras actividades para los niños o el fin de semana, y también cuando digan 'esa nos funcionó, guárdala'.",
    inputSchema: z.object({
      titulo: z.string(),
      descripcion: z.string().optional(),
      tipo: z.enum(["casa", "aire_libre", "fin_semana"]),
      paraQuien: z.string().optional().describe("Nombre del niño/integrante, si es para uno en particular"),
      yaFunciono: z.boolean().optional().default(false).describe("true si la familia ya la probó y le gustó"),
    }),
    execute: async ({ titulo, descripcion, tipo, paraQuien, yaFunciono }) => {
      let forId: string | null = null;
      if (paraQuien) {
        const m = await findMemberByName(d, paraQuien);
        if (!m) return { error: `No encontré a ningún integrante llamado ${paraQuien}.` };
        forId = m.id;
      }
      const now = Date.now();
      await d.run(
        `INSERT INTO family_activities (id, title, description, kind, for_member, is_favorite, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId(), titulo, descripcion ?? null, tipo, forId, yaFunciono ? 1 : 0, now, now],
      );
      return { ok: true, mensaje: `Actividad "${titulo}" guardada${yaFunciono ? " como favorita" : ""}.` };
    },
  });

  const listarActividadesFamiliares = tool({
    description: "Lista las actividades familiares guardadas, opcionalmente filtradas por tipo o solo las favoritas (ya probadas).",
    inputSchema: z.object({
      tipo: z.enum(["casa", "aire_libre", "fin_semana"]).optional(),
      soloFavoritas: z.boolean().optional().default(false),
    }),
    execute: async ({ tipo, soloFavoritas }) => {
      const rows = await d.all<{ title: string; description: string | null; kind: string; for_member: string | null; is_favorite: number }>(
        "SELECT title, description, kind, for_member, is_favorite FROM family_activities ORDER BY is_favorite DESC, created_at DESC",
      );
      const members = await listMembers(d);
      const nameById = new Map(members.map((m) => [m.id, m.name]));
      const filtered = rows.filter((r) => (!tipo || r.kind === tipo) && (!soloFavoritas || r.is_favorite === 1));
      return {
        actividades: filtered.map((r) => ({
          titulo: r.title,
          descripcion: r.description,
          tipo: r.kind,
          paraQuien: r.for_member ? (nameById.get(r.for_member) ?? null) : null,
          favorita: r.is_favorite === 1,
        })),
      };
    },
  });

  const marcarActividadFavorita = tool({
    description: "Marca una actividad guardada como favorita (ya la probaron y funcionó).",
    inputSchema: z.object({ titulo: z.string() }),
    execute: async ({ titulo }) => {
      const row = await d.first<{ id: string }>("SELECT id FROM family_activities WHERE title LIKE ? ORDER BY created_at DESC LIMIT 1", [`%${titulo}%`]);
      if (!row) return { error: `No encontré ninguna actividad que coincida con "${titulo}".` };
      await d.run("UPDATE family_activities SET is_favorite = 1, updated_at = ? WHERE id = ?", [Date.now(), row.id]);
      return { ok: true, mensaje: "Marcada como favorita." };
    },
  });

  const consultarInteresesNinos = tool({
    description: "Trae edad e intereses de cada integrante (útil antes de sugerir actividades) — incluye a todos, no solo a los niños.",
    inputSchema: z.object({}),
    execute: async () => {
      const members = await listMembers(d);
      return {
        integrantes: members.map((m) => ({ nombre: m.name, edad: ageFromBirthdate(m.birthdate), intereses: m.interests })),
      };
    },
  });

  const registrarTransaccion = tool({
    description:
      "Registra un ingreso o un gasto. Si es un INGRESO y hay sobres/fondos definidos (definirFondoFinanciero), el dinero se reparte SOLO entre ellos automáticamente (porcentajes primero, luego fijos como alquiler/comida hasta su meta del mes, el resto a ahorro) — te devuelve el reparto para que se lo cuentes a la familia. Si es un GASTO y coincide con un sobre (por categoría o por el parámetro fondo), se descuenta de ese sobre y avisa si lo deja en negativo; si hay presupuesto simple definido para la categoría (o 'Total'), también avisa si se pasa.",
    inputSchema: z.object({
      tipo: z.enum(["ingreso", "gasto"]),
      monto: z.number().positive(),
      categoria: z.string().describe("ej. 'Súper', 'Alquiler', 'Nómina de Jehan', 'Freelance'"),
      descripcion: z.string().optional().describe("Para ingresos, de dónde viene; para gastos, detalle corto"),
      fecha: z.string().optional().describe("YYYY-MM-DD, por default hoy"),
      fondo: z.string().optional().describe("Solo gastos: nombre exacto del sobre del que sale el dinero, si no coincide con la categoría"),
      privado: z.boolean().optional().default(false).describe("true = solo quien la registra y los admins la ven (ej. un gasto personal)"),
    }),
    execute: async ({ tipo, monto, categoria, descripcion, fecha, fondo, privado }) => {
      const date = fecha ?? todayInTZ(ctx.env);
      const month = date.slice(0, 7);
      const senderChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const sender = senderChatId ? await findMemberByChatId(d, senderChatId) : null;
      const now = Date.now();
      const txId = newId();

      let fundId: string | null = null;
      if (tipo === "gasto") {
        const fundName = fondo ?? categoria;
        const fund = await d.first<FinanceFund>("SELECT * FROM finance_funds WHERE lower(name) = lower(?)", [fundName]);
        fundId = fund?.id ?? null;
      }

      await d.run(
        `INSERT INTO transactions (id, type, amount, category, description, member_id, fund_id, visibility, date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [txId, tipo, monto, categoria, descripcion ?? null, sender?.id ?? null, fundId, privado ? "privado" : "compartido", date, now, now],
      );

      if (tipo === "ingreso") {
        const reparto = await allocateIncomeToFunds(d, txId, monto, date);
        return {
          ok: true,
          mensaje: `Ingreso de ${monto} (${categoria}) registrado.`,
          repartoEnSobres: reparto.length
            ? reparto.map((r) => `${r.fondo}: ${r.monto.toFixed(2)}`)
            : ["No hay sobres/fondos definidos todavía — usa definirFondoFinanciero si quieren repartir automático."],
        };
      }

      const alertas: string[] = [];

      if (fundId) {
        const balance = await fundBalance(d, fundId);
        if (balance < 0) alertas.push(`El sobre "${fondo ?? categoria}" quedó en negativo: ${balance.toFixed(2)}.`);
      }

      const checkBudget = async (cat: string) => {
        const budget = await d.first<Budget>("SELECT * FROM budgets WHERE category = ?", [cat]);
        if (!budget) return null;
        const spent = await d.first<{ total: number }>(
          "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'gasto' AND category = ? AND substr(date, 1, 7) = ?",
          [cat, month],
        );
        const total = spent?.total ?? 0;
        return total > budget.monthly_limit ? { cat, total, limit: budget.monthly_limit } : null;
      };
      const overCategory = await checkBudget(categoria);
      const overTotal = categoria !== "Total" ? await checkBudget("Total") : null;
      for (const a of [overCategory, overTotal].filter((x): x is NonNullable<typeof x> => x != null)) {
        alertas.push(`Presupuesto de "${a.cat}" superado este mes: llevas ${a.total.toFixed(2)} de ${a.limit.toFixed(2)}.`);
      }

      if (alertas.length) {
        const owner = ctx.env.OWNER_TELEGRAM_CHAT_ID;
        for (const msg of alertas) if (owner) await sendTelegramMessage(ctx.env, owner, `💸 ${msg}`).catch(() => {});
      }

      return { ok: true, mensaje: `Gasto de ${monto} en "${categoria}" registrado.`, alertas };
    },
  });

  const listarTransacciones = tool({
    description: "Lista transacciones (ingresos/gastos) de un mes, opcionalmente filtradas por tipo o categoría. Si no se da el mes, es el actual.",
    inputSchema: z.object({
      mes: z.string().optional().describe("YYYY-MM, por default el mes actual"),
      tipo: z.enum(["ingreso", "gasto"]).optional(),
      categoria: z.string().optional(),
    }),
    execute: async ({ mes, tipo, categoria }) => {
      const month = mes ?? todayInTZ(ctx.env).slice(0, 7);
      const all = await d.all<Transaction>(
        "SELECT * FROM transactions WHERE substr(date, 1, 7) = ? ORDER BY date DESC, created_at DESC",
        [month],
      );
      const viewerChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const viewer = viewerChatId ? await findMemberByChatId(d, viewerChatId) : null;
      const isAdmin = viewer?.permission_tier === "admin";
      const rows = all.filter((r) => r.visibility !== "privado" || isAdmin || r.member_id === viewer?.id);

      const filtered = rows.filter((r) => (!tipo || r.type === tipo) && (!categoria || r.category.toLowerCase() === categoria.toLowerCase()));
      const totalIngresos = rows.filter((r) => r.type === "ingreso").reduce((s, r) => s + r.amount, 0);
      const totalGastos = rows.filter((r) => r.type === "gasto").reduce((s, r) => s + r.amount, 0);
      return {
        mes: month,
        totalIngresos,
        totalGastos,
        balance: totalIngresos - totalGastos,
        transacciones: filtered.map((r) => ({ tipo: r.type, monto: r.amount, categoria: r.category, descripcion: r.description, fecha: r.date, privada: r.visibility === "privado" })),
      };
    },
  });

  const definirPresupuesto = tool({
    description: "Define o actualiza el presupuesto mensual de una categoría. Usa la categoría 'Total' para el presupuesto general del mes.",
    inputSchema: z.object({ categoria: z.string(), montoMensual: z.number().positive() }),
    execute: async ({ categoria, montoMensual }) => {
      await d.run(
        `INSERT INTO budgets (category, monthly_limit, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit, updated_at = excluded.updated_at`,
        [categoria, montoMensual, Date.now()],
      );
      return { ok: true, mensaje: `Presupuesto de "${categoria}" fijado en ${montoMensual}/mes.` };
    },
  });

  const consultarPresupuestos = tool({
    description: "Consulta los presupuestos definidos y cuánto se ha gastado de cada uno este mes.",
    inputSchema: z.object({}),
    execute: async () => {
      const budgets = await d.all<Budget>("SELECT * FROM budgets ORDER BY category ASC");
      const month = todayInTZ(ctx.env).slice(0, 7);
      const result = [];
      for (const b of budgets) {
        const spent = await d.first<{ total: number }>(
          "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'gasto' AND category = ? AND substr(date, 1, 7) = ?",
          [b.category, month],
        );
        result.push({ categoria: b.category, presupuesto: b.monthly_limit, gastado: spent?.total ?? 0 });
      }
      return { mes: month, presupuestos: result };
    },
  });

  const fundInputShape = {
    nombre: z.string().describe("ej. 'Imprevistos', 'Actividades', 'Alquiler', 'Comida', 'Ahorro vacaciones'"),
    tipo: z.enum(["porcentaje", "fijo", "ahorro"]),
    porcentaje: z.number().min(0).max(100).optional().describe("Requerido si tipo='porcentaje'"),
    montoMensual: z.number().positive().optional().describe("Requerido si tipo='fijo': meta mensual (ej. renta, comida)"),
    esSuscripcion: z
      .boolean()
      .optional()
      .describe("true si es una app/programa/membresía que se paga en mensualidad (ej. Netflix, Spotify, ChatGPT, gimnasio, software) — false o vacío para gastos fijos que NO son suscripciones (alquiler, luz, agua)."),
    notas: z.string().optional(),
  };

  const upsertFund = async (input: z.infer<z.ZodObject<typeof fundInputShape>>): Promise<{ error: string } | { ok: true; mensaje: string }> => {
    if (input.tipo === "porcentaje" && input.porcentaje == null) return { error: `Falta el porcentaje para el sobre "${input.nombre}".` };
    if (input.tipo === "fijo" && input.montoMensual == null) return { error: `Falta el monto mensual para el sobre "${input.nombre}".` };
    const now = Date.now();
    await d.run(
      `INSERT INTO finance_funds (id, name, kind, percentage, monthly_target, notes, is_subscription, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET kind = excluded.kind, percentage = excluded.percentage, monthly_target = excluded.monthly_target, notes = excluded.notes, is_subscription = excluded.is_subscription, updated_at = excluded.updated_at`,
      [newId(), input.nombre, input.tipo, input.porcentaje ?? null, input.montoMensual ?? null, input.notas ?? null, input.esSuscripcion ? 1 : 0, now, now],
    );
    return { ok: true, mensaje: `Sobre "${input.nombre}" (${input.tipo}${input.tipo === "porcentaje" ? ` ${input.porcentaje}%` : input.tipo === "fijo" ? ` ${input.montoMensual}/mes` : ""}${input.esSuscripcion ? " · suscripción" : ""}) guardado.` };
  };

  const definirFondoFinanciero = tool({
    description:
      "Define o actualiza UN sobre/fondo financiero: 'porcentaje' (ej. 10% para Imprevistos), 'fijo' (meta mensual, ej. Alquiler 800 — se rellena con cada ingreso hasta llegar a la meta), o 'ahorro' (recibe lo que sobra, para varios sitios de ahorro separados). Para VARIOS sobres de una vez (ej. cada gasto fijo que te dieron) usa definirVariosFondos en una sola llamada — nunca llames esta varias veces seguidas, corta el turno. Antes de crear cualquiera, PREGÚNTALE a la familia qué porcentajes y montos quieren — no los inventes.",
    inputSchema: z.object(fundInputShape),
    execute: async (input) => upsertFund(input),
  });

  const definirVariosFondos = tool({
    description:
      "Define o actualiza VARIOS sobres/fondos financieros EN UNA SOLA LLAMADA — úsala siempre que vayas a crear más de uno (ej. un sobre 'fijo' por cada gasto fijo que te dieron, más los de porcentaje/ahorro), en vez de llamar definirFondoFinanciero varias veces seguidas.",
    inputSchema: z.object({ sobres: z.array(z.object(fundInputShape)).min(1).max(30) }),
    execute: async ({ sobres }) => {
      const resultados = [];
      for (const s of sobres) resultados.push(await upsertFund(s));
      const errores = resultados.filter((r): r is { error: string } => "error" in r).map((r) => r.error);
      const ok = resultados.length - errores.length;
      return { ok: true, mensaje: `${ok} de ${sobres.length} sobres guardados.`, errores: errores.length ? errores : undefined };
    },
  });

  const debtInputShape = {
    nombre: z.string().describe("ej. 'Tarjeta de crédito', 'Préstamo del carro'"),
    saldo: z.number().positive().describe("Lo que falta por pagar HOY, no el monto original del préstamo"),
    tasaAnual: z.number().min(0).max(100).optional().describe("Tasa de interés anual en %, si la conocen"),
    pagoMensual: z.number().positive().describe("Lo que están pagando cada mes actualmente"),
  };

  const upsertDebt = async (input: z.infer<z.ZodObject<typeof debtInputShape>>): Promise<{ error: string } | { ok: true; mensaje: string }> => {
    const now = Date.now();
    const existing = await d.first<{ id: string }>("SELECT id FROM debts WHERE lower(name) = lower(?)", [input.nombre]);
    if (existing) {
      await d.run("UPDATE debts SET balance = ?, annual_rate = ?, monthly_payment = ?, updated_at = ? WHERE id = ?", [
        input.saldo,
        input.tasaAnual ?? null,
        input.pagoMensual,
        now,
        existing.id,
      ]);
    } else {
      await d.run(
        `INSERT INTO debts (id, name, balance, annual_rate, monthly_payment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [newId(), input.nombre, input.saldo, input.tasaAnual ?? null, input.pagoMensual, now, now],
      );
    }
    return { ok: true, mensaje: `Deuda "${input.nombre}" guardada: saldo ${input.saldo}, pago mensual ${input.pagoMensual}${input.tasaAnual != null ? `, tasa ${input.tasaAnual}% anual` : ""}.` };
  };

  const registrarDeuda = tool({
    description: "Registra o actualiza UNA deuda/crédito/préstamo con su saldo actual, pago mensual y tasa si la conocen. Para VARIAS de golpe usa registrarVariasDeudas en una sola llamada.",
    inputSchema: z.object(debtInputShape),
    execute: async (input) => upsertDebt(input),
  });

  const registrarVariasDeudas = tool({
    description: "Registra VARIAS deudas/créditos EN UNA SOLA LLAMADA — úsala cuando te den más de una de golpe, en vez de llamar registrarDeuda varias veces seguidas.",
    inputSchema: z.object({ deudas: z.array(z.object(debtInputShape)).min(1).max(20) }),
    execute: async ({ deudas }) => {
      const resultados = [];
      for (const dda of deudas) resultados.push(await upsertDebt(dda));
      return { ok: true, mensaje: `${resultados.length} deuda(s) guardada(s).` };
    },
  });

  const listarDeudas = tool({
    description: "Lista las deudas registradas, con cuántos meses faltan e interés total restante al ritmo de pago actual de cada una.",
    inputSchema: z.object({}),
    execute: async () => {
      const debts = await d.all<Debt>("SELECT * FROM debts ORDER BY created_at ASC");
      return {
        deudas: debts.map((dd) => {
          const payoff = loanPayoff(dd.balance, dd.annual_rate, dd.monthly_payment);
          return {
            nombre: dd.name,
            saldo: dd.balance,
            tasaAnual: dd.annual_rate,
            pagoMensual: dd.monthly_payment,
            mesesRestantes: payoff?.months ?? null,
            interesTotalRestante: payoff?.totalInterest ?? null,
            advertencia: payoff ? undefined : "El pago mensual actual no alcanza a cubrir ni el interés — así nunca se paga, hay que subir el pago.",
          };
        }),
      };
    },
  });

  const borrarDeuda = tool({
    description: "Borra una deuda ya pagada por completo.",
    inputSchema: z.object({ nombre: z.string() }),
    execute: async ({ nombre }) => {
      const dd = await d.first<{ id: string }>("SELECT id FROM debts WHERE lower(name) = lower(?)", [nombre]);
      if (!dd) return { error: `No encontré ninguna deuda llamada ${nombre}.` };
      await d.run("DELETE FROM debts WHERE id = ?", [dd.id]);
      return { ok: true, mensaje: `Deuda "${nombre}" borrada.` };
    },
  });

  const simularPagoDeuda = tool({
    description:
      "Simula 'qué pasa si...' con una deuda: pagar más cada mes, y/o abonar un monto único hoy para reducir el saldo. Compara meses e interés del escenario actual contra el nuevo. Úsala cuando pregunten '¿qué pasa si pago 50 más al mes?' o '¿me conviene abonar 500 de una vez?'.",
    inputSchema: z.object({
      nombre: z.string(),
      pagoMensualExtra: z.number().positive().optional().describe("Cuánto MÁS pagarían cada mes, sumado al pago actual"),
      abonoUnico: z.number().positive().optional().describe("Monto que abonarían una sola vez hoy, reduciendo el saldo antes de seguir pagando igual"),
    }),
    execute: async ({ nombre, pagoMensualExtra, abonoUnico }) => {
      if (!pagoMensualExtra && !abonoUnico) return { error: "Dame al menos un escenario: cuánto pagarían de más al mes, o cuánto abonarían de una vez." };
      const dd = await d.first<Debt>("SELECT * FROM debts WHERE lower(name) = lower(?)", [nombre]);
      if (!dd) return { error: `No encontré ninguna deuda llamada ${nombre}.` };

      const actual = loanPayoff(dd.balance, dd.annual_rate, dd.monthly_payment);
      const resultado: Record<string, unknown> = {
        deuda: nombre,
        saldoActual: dd.balance,
        pagoMensualActual: dd.monthly_payment,
        escenarioActual: actual ? { meses: actual.months, interesTotal: actual.totalInterest } : "El pago actual no alcanza a cubrir el interés.",
      };

      if (pagoMensualExtra) {
        const nuevo = loanPayoff(dd.balance, dd.annual_rate, dd.monthly_payment + pagoMensualExtra);
        resultado.siPagaMasAlMes = {
          pagoNuevo: dd.monthly_payment + pagoMensualExtra,
          meses: nuevo?.months ?? null,
          interesTotal: nuevo?.totalInterest ?? null,
          mesesAhorrados: actual && nuevo ? actual.months - nuevo.months : null,
          interesAhorrado: actual && nuevo ? Math.round((actual.totalInterest - nuevo.totalInterest) * 100) / 100 : null,
        };
      }

      if (abonoUnico) {
        const saldoReducido = Math.max(0, dd.balance - abonoUnico);
        const nuevo = loanPayoff(saldoReducido, dd.annual_rate, dd.monthly_payment);
        resultado.siAbonaDeGolpe = {
          abono: abonoUnico,
          saldoDespuesDelAbono: saldoReducido,
          meses: nuevo?.months ?? null,
          interesTotal: nuevo?.totalInterest ?? null,
          mesesAhorrados: actual && nuevo ? actual.months - nuevo.months : null,
          interesAhorrado: actual && nuevo ? Math.round((actual.totalInterest - nuevo.totalInterest) * 100) / 100 : null,
        };
      }

      return resultado;
    },
  });

  const listarFondosFinancieros = tool({
    description: "Lista los sobres/fondos definidos con su saldo actual (lo asignado menos lo gastado de cada uno).",
    inputSchema: z.object({}),
    execute: async () => {
      const funds = await d.all<FinanceFund>("SELECT * FROM finance_funds ORDER BY created_at ASC");
      const result = [];
      for (const f of funds) {
        result.push({
          nombre: f.name,
          tipo: f.kind,
          porcentaje: f.percentage,
          metaMensual: f.monthly_target,
          esSuscripcion: !!f.is_subscription,
          saldoActual: await fundBalance(d, f.id),
          notas: f.notes,
        });
      }
      return { sobres: result };
    },
  });

  const revocarAcceso = tool({
    description:
      "Revoca los accesos activos de un integrante: cierra todas sus sesiones web y desvincula su Telegram (también cancela cualquier enlace de invitación suyo sin usar). No borra su perfil ni sus datos — puede volver a conectarse si le generas un enlace nuevo. Úsalo cuando digan 'quítale el acceso a X' o 'cierra la sesión de X en todos lados'.",
    inputSchema: z.object({ nombre: z.string() }),
    execute: async ({ nombre }) => {
      const check = await requireAdminSender(ctx);
      if (!check.ok) return { error: check.error };

      const member = await findMemberByName(d, nombre);
      if (!member) return { error: `No encontré a ningún integrante llamado ${nombre}.` };

      const now = Date.now();
      await d.run("UPDATE family_members SET telegram_chat_id = NULL, updated_at = ? WHERE id = ?", [now, member.id]);
      await d.run("DELETE FROM family_web_sessions WHERE member_id = ?", [member.id]);
      await d.run("UPDATE family_invites SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL", [now, member.id]);
      await d.run("UPDATE family_web_invites SET revoked_at = ? WHERE member_id = ? AND used_at IS NULL AND revoked_at IS NULL", [now, member.id]);

      return { ok: true, mensaje: `Accesos de ${nombre} revocados: se desconectó su Telegram y se cerraron sus sesiones web. Sigue registrado — puedes generarle un enlace nuevo cuando quieran reconectarlo.` };
    },
  });

  const unirseConEnlace = tool({
    description:
      "Conecta a quien escribe con su perfil de familia usando el código de un enlace de invitación (mensajes que empiezan con '/start '). Llama esta tool SIEMPRE que el mensaje sea justo eso, antes de responder cualquier otra cosa.",
    inputSchema: z.object({ token: z.string().describe("El código después de '/start '") }),
    execute: async ({ token }) => {
      const invite = await d.first<{ token: string; member_id: string; used_at: number | null; expires_at: number | null; revoked_at: number | null }>(
        "SELECT * FROM family_invites WHERE token = ?",
        [token],
      );
      if (!invite) return { error: "Ese enlace no es válido. Pide uno nuevo a quien te lo mandó." };
      if (invite.used_at) return { error: "Ese enlace ya se usó. Pide uno nuevo." };
      if (invite.revoked_at) return { error: "Ese enlace fue cancelado. Pide uno nuevo." };
      if (invite.expires_at && invite.expires_at < Date.now()) return { error: "Ese enlace ya caducó. Pide uno nuevo." };

      const chatId = await getSenderChannelUserId(d, ctx.getConversationId());
      if (!chatId) return { error: "No pude identificar tu chat." };

      const member = await d.first<FamilyMember>("SELECT * FROM family_members WHERE id = ?", [
        invite.member_id,
      ]);
      if (!member) return { error: "El integrante de este enlace ya no existe." };

      await d.run("UPDATE family_members SET telegram_chat_id = ?, updated_at = ? WHERE id = ?", [
        chatId,
        Date.now(),
        member.id,
      ]);
      await d.run("UPDATE family_invites SET used_at = ? WHERE token = ?", [Date.now(), token]);

      return {
        ok: true,
        mensaje: `¡Listo, ${member.name}! Quedaste conectado como parte de la familia. Ya puedo ayudarte con tareas de la casa y con tu perfil.`,
      };
    },
  });

  const crearRecordatorio = tool({
    description:
      "Crea un recordatorio real: llega por Telegram justo a la hora indicada a quien corresponda. Úsalo cuando pidan que se les avise a una hora específica ('recuérdame a las 8 sacar la basura'), distinto de una tarea con fecha límite.",
    inputSchema: z.object({
      titulo: z.string(),
      fecha: z.string().describe("YYYY-MM-DD"),
      hora: z.string().describe("HH:MM, 24 horas"),
      paraQuien: z.string().optional().describe("Nombre del integrante — si no se da, avisa a todos los de acceso completo"),
      repetir: z.enum(["diario", "semanal", "mensual"]).optional().describe("Si se repite; si no, es una sola vez"),
    }),
    execute: async ({ titulo, fecha, hora, paraQuien, repetir }) => {
      let targetId: string | null = null;
      if (paraQuien) {
        const m = await findMemberByName(d, paraQuien);
        if (!m) return { error: `No encontré a ningún integrante llamado ${paraQuien}.` };
        targetId = m.id;
      }
      const remindAt = zonedDateTimeToUtcMs(fecha, hora, ctx.env);
      if (remindAt <= Date.now()) return { error: "Esa fecha y hora ya pasaron." };

      const senderChatId = await getSenderChannelUserId(d, ctx.getConversationId());
      const sender = senderChatId ? await findMemberByChatId(d, senderChatId) : null;

      const id = newId();
      await d.run(
        `INSERT INTO reminders (id, title, remind_at, target_member, repeat, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        [id, titulo, remindAt, targetId, repetir ?? null, sender?.id ?? null, Date.now()],
      );
      return { ok: true, id, mensaje: `Recordatorio "${titulo}" programado para el ${formatDateTimeInTZ(remindAt, ctx.env)}${repetir ? ` (repite: ${repetir})` : ""}.` };
    },
  });

  const listarRecordatorios = tool({
    description: "Lista los próximos recordatorios pendientes.",
    inputSchema: z.object({}),
    execute: async () => {
      const rows = await d.all<Reminder>(
        "SELECT * FROM reminders WHERE status = 'pending' ORDER BY remind_at ASC LIMIT 20",
      );
      const members = await listMembers(d);
      const nameById = new Map(members.map((m) => [m.id, m.name]));
      return {
        recordatorios: rows.map((r) => ({
          id: r.id,
          titulo: r.title,
          cuando: formatDateTimeInTZ(r.remind_at, ctx.env),
          paraQuien: r.target_member ? (nameById.get(r.target_member) ?? "?") : "todos",
          repite: r.repeat,
        })),
      };
    },
  });

  const cancelarRecordatorio = tool({
    description: "Cancela un recordatorio pendiente por su título (o parte de él).",
    inputSchema: z.object({ titulo: z.string() }),
    execute: async ({ titulo }) => {
      const row = await d.first<{ id: string; title: string }>(
        "SELECT id, title FROM reminders WHERE status = 'pending' AND title LIKE ? ORDER BY remind_at ASC LIMIT 1",
        [`%${titulo}%`],
      );
      if (!row) return { error: `No encontré un recordatorio pendiente que coincida con "${titulo}".` };
      await d.run("UPDATE reminders SET status = 'cancelled' WHERE id = ?", [row.id]);
      return { ok: true, mensaje: `Recordatorio "${row.title}" cancelado.` };
    },
  });

  const baseTools: Record<string, unknown> = {
    registrarIntegranteFamilia,
    generarEnlaceInvitacion,
    generarEnlaceAccesoWeb,
    revocarAcceso,
    actualizarDatosIntegrante,
    consultarIntegrante,
    listarFamilia,
    registrarTareaCasa,
    registrarVariasTareas,
    listarTareasCasa,
    completarTareaCasa,
    crearRecordatorio,
    listarRecordatorios,
    cancelarRecordatorio,
    agregarProductoCompra,
    agregarVariosProductosCompra,
    listarListaCompra,
    marcarProductoComprado,
    definirMenuDia,
    definirMenuSemanal,
    consultarMenuDia,
    consultarPerfilNutricionalFamilia,
    consultarPerfilFisicoFamilia,
    guardarPlanEjercicio,
    consultarPlanEjercicio,
    guardarActividadFamiliar,
    listarActividadesFamiliares,
    marcarActividadFavorita,
    consultarInteresesNinos,
    registrarTransaccion,
    listarTransacciones,
    definirPresupuesto,
    consultarPresupuestos,
    definirFondoFinanciero,
    definirVariosFondos,
    registrarDeuda,
    registrarVariasDeudas,
    listarDeudas,
    borrarDeuda,
    simularPagoDeuda,
    listarFondosFinancieros,
    unirseConEnlace,
  };

  // Búsqueda web real (precios/ofertas de super, etc.) — usa el tool nativo de
  // Anthropic (web_search), corre server-side con la misma ANTHROPIC_API_KEY,
  // sin necesitar otra llave. Solo aplica si el proveedor activo es Anthropic.
  if (resolveProvider(ctx.env) === "anthropic" && ctx.env.ANTHROPIC_API_KEY) {
    const anthropicProvider = createAnthropic({ apiKey: ctx.env.ANTHROPIC_API_KEY });
    baseTools.buscarEnInternet = anthropicProvider.tools.webSearch_20260209({
      maxUses: 5,
      userLocation: { type: "approximate", country: "DE", timezone: ctx.env.BOT_TIMEZONE || "Europe/Berlin" },
    });
  }

  return baseTools;
}
