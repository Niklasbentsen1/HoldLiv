// Frugt og opgaver (modul "tasks"): frugtliste til kampe og træninger, og opgaver som kridtning og oprydning.
// En opgave hører til en familie: en spiller på holdet og dennes værger. Søskende på samme hold er én familie.
//
// Hvem må hvad:
//   - Trænere og admin opretter og sletter opgaver, laver frugtlister, fordeler og skriver familier på.
//   - En familie kan tage en opgave, der ingen har, give den fra sig igen og sætte den som udført.
//   - Alle på holdet kan se, hvem der har hvilke opgaver og hvor mange hver familie har haft, så fordelingen er åben.
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { eventResponses, events, guardianships, profiles, teamMembers, teamTasks } from "../db/schema";
import { can, canActAs, type AccessContext } from "../auth/permissions";
import { distribute, type FamilyLoad } from "../modules/fairness";
import { requireModule } from "./modules";

export type TaskKind = "fruit" | "task";
/** Frugt hører til træninger og kampe, ikke til fx forældremøder. */
const FRUIT_EVENT_TYPES = ["training", "match"];
export const TASK_KIND_LABEL: Record<TaskKind, string> = { fruit: "Frugt", task: "Opgave" };

type Reader = Pick<Db, "select">;

const leads = (ctx: AccessContext, team: { teamId: string; clubId: string }) => can(ctx, { action: "team.manage", team });

interface Family {
  key: string;
  assigneeId: string;
  name: string;
  playerIds: string[];
  /** Hvornår den første af familiens spillere kom på holdet. */
  joinedAt: number;
}

/** Holdets familier. Spillere med de samme værger er én familie; spillere uden værger står for sig selv. */
async function loadFamilies(db: Reader, teamId: string): Promise<Family[]> {
  const players = await db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, joinedAt: teamMembers.createdAt })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))
    .orderBy(asc(profiles.firstName), asc(profiles.lastName));
  if (players.length === 0) return [];
  const guardians = await db
    .select({ childId: guardianships.childProfileId, guardianId: guardianships.guardianProfileId })
    .from(guardianships)
    .where(inArray(guardianships.childProfileId, players.map((p) => p.id)));
  const byKey = new Map<string, Family>();
  for (const p of players) {
    const gs = guardians.filter((g) => g.childId === p.id).map((g) => g.guardianId).sort();
    const key = gs.length ? gs.join("+") : p.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.playerIds.push(p.id);
      existing.name = `${existing.name} og ${p.firstName}`;
      existing.joinedAt = Math.min(existing.joinedAt, p.joinedAt.getTime());
    } else {
      byKey.set(key, { key, assigneeId: p.id, name: `${p.firstName} ${p.lastName}`, playerIds: [p.id], joinedAt: p.joinedAt.getTime() });
    }
  }
  return [...byKey.values()];
}

const familyOf = (families: Family[], profileId: string) => families.find((f) => f.playerIds.includes(profileId));

async function loadTask(db: Reader, taskId: string) {
  const [t] = await db.select().from(teamTasks).where(eq(teamTasks.id, taskId));
  if (!t) throw new Error("Opgaven findes ikke");
  return t;
}

async function assertPlayer(db: Reader, teamId: string, profileId: string) {
  const [row] = await db
    .select({ id: teamMembers.profileId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, profileId), eq(teamMembers.role, "player")));
  if (!row) throw new Error("Spilleren er ikke på holdet.");
}

export interface TaskInput {
  kind: TaskKind;
  title: string;
  note?: string | null;
  eventId?: string | null;
}

async function assertTeamEvent(db: Reader, teamId: string, eventId: string) {
  const [e] = await db.select({ teamId: events.teamId }).from(events).where(eq(events.id, eventId));
  if (!e || e.teamId !== teamId) throw new Error("Aktiviteten hører ikke til holdet.");
}

/** Træner/admin opretter en opgave. */
export async function createTask(db: Db, ctx: AccessContext, teamId: string, input: TaskInput) {
  const { team } = await requireModule(db, ctx, teamId, "tasks");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer opretter opgaver.");
  const title = input.title.trim();
  if (!title) throw new Error("Skriv hvad opgaven er.");
  if (input.eventId) await assertTeamEvent(db, teamId, input.eventId);
  const [task] = await db
    .insert(teamTasks)
    .values({ teamId, kind: input.kind, title, note: input.note?.trim() || null, eventId: input.eventId ?? null, createdByUserId: ctx.userId })
    .returning();
  return task;
}

export async function deleteTask(db: Db, ctx: AccessContext, taskId: string) {
  const task = await loadTask(db, taskId);
  const { team } = await requireModule(db, ctx, task.teamId, "tasks");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer sletter opgaver.");
  await db.delete(teamTasks).where(eq(teamTasks.id, taskId));
}

/**
 * Familiernes belastning for én slags opgave: antal opgaver indtil nu og hvornår de sidst fik en.
 * En familie, der først kom på holdet efter at fordelingen var begyndt, starter ikke på nul, men får en fast
 * forskydning svarende til det færreste, de øvrige havde fået, da den kom, så den ikke skal indhente det forsømte.
 */
async function familyLoads(db: Reader, teamId: string, kind: TaskKind, families: Family[]): Promise<FamilyLoad[]> {
  const rows = await db
    .select({ assignee: teamTasks.assigneeProfileId, assignedAt: teamTasks.assignedAt })
    .from(teamTasks)
    .where(and(eq(teamTasks.teamId, teamId), eq(teamTasks.kind, kind), sql`${teamTasks.assigneeProfileId} is not null`));
  const firstAssigned = Math.min(...rows.map((r) => r.assignedAt?.getTime() ?? Infinity));
  const own = (f: Family) => rows.filter((r) => r.assignee && f.playerIds.includes(r.assignee));
  const established = families.filter((f) => f.joinedAt <= firstAssigned);
  return families.map((f) => {
    const mine = own(f);
    // Fast forskydning for en familie, der kom til efter fordelingen begyndte: det færreste antal opgaver, de øvrige
    // familier havde fået, da den kom på holdet. Så starter den lige med dem, og indhenter ikke bagud.
    const offset =
      f.joinedAt > firstAssigned && established.length
        ? Math.min(...established.map((o) => own(o).filter((r) => (r.assignedAt?.getTime() ?? 0) < f.joinedAt).length))
        : 0;
    return {
      key: f.key,
      assigneeId: f.assigneeId,
      name: f.name,
      load: mine.length + offset,
      lastAt: Math.max(0, ...mine.map((r) => r.assignedAt?.getTime() ?? 0)),
    };
  });
}

/**
 * Fordel alle opgaver uden familie retfærdigt: hver opgave går til den familie, der har haft færrest af samme slags.
 * Familier, hvor alle børn har meldt fra til opgavens aktivitet, springes over. Opgaver der allerede er skrevet på
 * en familie, røres ikke. Returnerer antal opgaver der blev fordelt.
 */
export async function distributeOpenTasks(db: Db, ctx: AccessContext, teamId: string, kind?: TaskKind) {
  const { team } = await requireModule(db, ctx, teamId, "tasks");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer fordeler opgaver.");
  return db.transaction(async (tx) => {
    // Rækkelås på holdets uløste opgaver, så to fordelinger samtidig ikke giver den samme opgave to familier.
    const open = await tx
      .select({ id: teamTasks.id, kind: teamTasks.kind, eventId: teamTasks.eventId, startsAt: events.startsAt, cancelledAt: events.cancelledAt, createdAt: teamTasks.createdAt })
      .from(teamTasks)
      .leftJoin(events, eq(events.id, teamTasks.eventId))
      .where(and(eq(teamTasks.teamId, teamId), isNull(teamTasks.assigneeProfileId), isNull(teamTasks.doneAt), ...(kind ? [eq(teamTasks.kind, kind)] : [])))
      .orderBy(asc(events.startsAt), asc(teamTasks.createdAt))
      .for("update", { of: teamTasks });
    // Opgaver til aflyste eller overståede aktiviteter fordeles ikke.
    const live = open.filter((t) => !t.cancelledAt && !(t.startsAt && t.startsAt.getTime() <= ctx.now.getTime()));
    if (live.length === 0) return 0;
    const families = await loadFamilies(tx, teamId);
    if (families.length === 0) throw new Error("Holdet har ingen spillere at fordele til.");
    const eventIds = [...new Set(live.flatMap((t) => (t.eventId ? [t.eventId] : [])))];
    const declined = eventIds.length
      ? await tx
          .select({ eventId: eventResponses.eventId, profileId: eventResponses.profileId })
          .from(eventResponses)
          .where(and(inArray(eventResponses.eventId, eventIds), eq(eventResponses.status, "no")))
      : [];
    const now = ctx.now.getTime();
    let assigned = 0;
    for (const k of ["fruit", "task"] as const) {
      const items = live.filter((t) => t.kind === k);
      if (items.length === 0) continue;
      const loads = await familyLoads(tx, teamId, k, families);
      const plan = distribute(
        loads,
        items.map((t) => ({
          id: t.id,
          skip: new Set(
            families
              .filter((f) => t.eventId && f.playerIds.every((p) => declined.some((d) => d.eventId === t.eventId && d.profileId === p)))
              .map((f) => f.key),
          ),
        })),
      );
      for (const [taskId, assignee] of plan) {
        await tx.update(teamTasks).set({ assigneeProfileId: assignee, assignedAt: new Date(now) }).where(eq(teamTasks.id, taskId));
        assigned++;
      }
    }
    return assigned;
  });
}

/**
 * Lav en frugtliste: én frugtopgave pr. valgt aktivitet (aktiviteter der allerede har en, springes over),
 * og fordel dem straks retfærdigt. Returnerer antal nye opgaver.
 */
export async function createFruitList(db: Db, ctx: AccessContext, teamId: string, eventIds: string[]) {
  const { team } = await requireModule(db, ctx, teamId, "tasks");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer laver frugtlister.");
  if (eventIds.length === 0) throw new Error("Vælg mindst én aktivitet.");
  const unique = [...new Set(eventIds)];
  for (const id of unique) await assertTeamEvent(db, teamId, id);
  const rows = await db.select({ id: events.id, type: events.type }).from(events).where(inArray(events.id, unique));
  if (rows.some((r) => !FRUIT_EVENT_TYPES.includes(r.type))) throw new Error("Frugt hører til træninger og kampe.");
  // Det unikke indeks på frugt pr. aktivitet gør, at to samtidige kald ikke giver dobbelte opgaver.
  const created = await db
    .insert(teamTasks)
    .values(unique.map((eventId) => ({ teamId, kind: "fruit" as const, title: "Frugt", eventId, createdByUserId: ctx.userId })))
    .onConflictDoNothing()
    .returning({ id: teamTasks.id });
  await distributeOpenTasks(db, ctx, teamId, "fruit");
  return created.length;
}

/** Træner/admin skriver en opgave på en bestemt familie (eller fjerner familien igen med null). */
export async function assignTask(db: Db, ctx: AccessContext, taskId: string, assigneeProfileId: string | null) {
  const task = await loadTask(db, taskId);
  const { team } = await requireModule(db, ctx, task.teamId, "tasks");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer skriver opgaver på familier.");
  if (task.doneAt) throw new Error("Opgaven er allerede udført.");
  if (assigneeProfileId) await assertPlayer(db, task.teamId, assigneeProfileId);
  await db
    .update(teamTasks)
    .set({ assigneeProfileId, assignedAt: assigneeProfileId ? new Date() : null })
    .where(eq(teamTasks.id, taskId));
}

/** En familie tager en opgave, der ingen har. profileId er det barn (eller den spiller), familien tager den for. */
export async function claimTask(db: Db, ctx: AccessContext, taskId: string, profileId: string) {
  const task = await loadTask(db, taskId);
  const { team } = await requireModule(db, ctx, task.teamId, "tasks");
  if (!canActAs(ctx, profileId) && !leads(ctx, team)) throw new Error("Du må ikke tage opgaver for den spiller.");
  await assertPlayer(db, task.teamId, profileId);
  if (task.eventId) {
    const [e] = await db.select({ cancelledAt: events.cancelledAt }).from(events).where(eq(events.id, task.eventId));
    if (e?.cancelledAt) throw new Error("Aktiviteten er aflyst.");
  }
  // Betinget opdatering: er opgaven taget imellemtiden, rammer den ingen række.
  const [row] = await db
    .update(teamTasks)
    .set({ assigneeProfileId: profileId, assignedAt: new Date() })
    .where(and(eq(teamTasks.id, taskId), isNull(teamTasks.assigneeProfileId), isNull(teamTasks.doneAt)))
    .returning({ id: teamTasks.id });
  if (!row) throw new Error("Opgaven er allerede taget.");
}

/** Familien giver opgaven fra sig, så den kan tages af en anden. Trænere kan også. */
export async function releaseTask(db: Db, ctx: AccessContext, taskId: string) {
  const task = await loadTask(db, taskId);
  const { team } = await requireModule(db, ctx, task.teamId, "tasks");
  const mine = task.assigneeProfileId && canActAs(ctx, task.assigneeProfileId);
  if (!mine && !leads(ctx, team)) throw new Error("Det er ikke jeres opgave.");
  if (task.doneAt) throw new Error("Opgaven er allerede udført.");
  await db.update(teamTasks).set({ assigneeProfileId: null, assignedAt: null }).where(eq(teamTasks.id, taskId));
}

/** Sæt en opgave som udført (eller fortryd). Familien der har den, og trænere. */
export async function setTaskDone(db: Db, ctx: AccessContext, taskId: string, done: boolean) {
  const task = await loadTask(db, taskId);
  const { team } = await requireModule(db, ctx, task.teamId, "tasks");
  const mine = task.assigneeProfileId && canActAs(ctx, task.assigneeProfileId);
  if (!mine && !leads(ctx, team)) throw new Error("Det er ikke jeres opgave.");
  if (!task.assigneeProfileId) throw new Error("Opgaven har ingen familie endnu.");
  await db
    .update(teamTasks)
    .set(done ? { doneAt: new Date(), doneByUserId: ctx.userId } : { doneAt: null, doneByUserId: null })
    .where(eq(teamTasks.id, taskId));
}

/** Holdets opgaver: åbne (nærmeste først), de seneste udførte og hvor mange hver familie har haft. */
export async function listTasks(db: Db, ctx: AccessContext, teamId: string) {
  const { team } = await requireModule(db, ctx, teamId, "tasks");
  const lead = leads(ctx, team);
  const [families, rows] = await Promise.all([
    loadFamilies(db, teamId),
    db
      .select({
        task: teamTasks,
        eventTitle: events.title,
        eventStartsAt: events.startsAt,
        eventCancelledAt: events.cancelledAt,
      })
      .from(teamTasks)
      .leftJoin(events, eq(events.id, teamTasks.eventId))
      .where(eq(teamTasks.teamId, teamId))
      .orderBy(asc(events.startsAt), asc(teamTasks.createdAt)),
  ]);

  const view = (r: (typeof rows)[number]) => {
    const t = r.task;
    const family = t.assigneeProfileId ? familyOf(families, t.assigneeProfileId) : undefined;
    const mine = !!t.assigneeProfileId && canActAs(ctx, t.assigneeProfileId);
    const cancelled = !!r.eventCancelledAt;
    const open = !t.doneAt && !cancelled;
    return {
      id: t.id,
      kind: t.kind,
      title: t.title,
      note: t.note,
      event: t.eventId ? { id: t.eventId, title: r.eventTitle!, startsAt: r.eventStartsAt! } : null,
      cancelled,
      done: !!t.doneAt,
      assignee: family ? { profileId: t.assigneeProfileId!, name: family.name } : null,
      mine,
      canRelease: open && !!t.assigneeProfileId && (mine || lead),
      canComplete: !cancelled && !!t.assigneeProfileId && (mine || lead),
    };
  };

  const items = rows.map(view);
  const myPlayers = families.flatMap((f) => f.playerIds).filter((p) => canActAs(ctx, p));
  const myFamilies = [...new Map(myPlayers.map((p) => [familyOf(families, p)!.key, familyOf(families, p)!])).values()];

  return {
    canManage: lead,
    open: items.filter((t) => !t.done && !t.cancelled).map((t) => ({ ...t, canClaim: !t.assignee && myFamilies.length > 0 })),
    done: items.filter((t) => t.done).slice(-20).reverse(),
    /** Familier man selv kan tage opgaver for. */
    myFamilies: myFamilies.map((f) => ({ assigneeId: f.assigneeId, name: f.name })),
    /** Familierne med antal frugt- og andre opgaver indtil nu. */
    families: families.map((f) => {
      const mineRows = rows.filter((r) => r.task.assigneeProfileId && f.playerIds.includes(r.task.assigneeProfileId));
      return {
        assigneeId: f.assigneeId,
        name: f.name,
        fruit: mineRows.filter((r) => r.task.kind === "fruit").length,
        tasks: mineRows.filter((r) => r.task.kind === "task").length,
      };
    }),
  };
}

/** Kommende aktiviteter der kan få frugt, til trænerens formular. */
export async function listFruitCandidates(db: Db, ctx: AccessContext, teamId: string, limit = 12) {
  await requireModule(db, ctx, teamId, "tasks");
  const have = new Set(
    (await db.select({ e: teamTasks.eventId }).from(teamTasks).where(and(eq(teamTasks.teamId, teamId), eq(teamTasks.kind, "fruit")))).map((r) => r.e),
  );
  const rows = await db
    .select({ id: events.id, title: events.title, type: events.type, startsAt: events.startsAt })
    .from(events)
    .where(and(eq(events.teamId, teamId), gt(events.startsAt, ctx.now), isNull(events.cancelledAt), inArray(events.type, ["training", "match"])))
    .orderBy(asc(events.startsAt))
    .limit(limit + have.size);
  return rows.filter((r) => !have.has(r.id)).slice(0, limit);
}

/** Kommende aktiviteter en opgave kan høre til. */
export async function listTaskEvents(db: Db, ctx: AccessContext, teamId: string, limit = 12) {
  await requireModule(db, ctx, teamId, "tasks");
  return db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt })
    .from(events)
    .where(and(eq(events.teamId, teamId), gt(events.startsAt, ctx.now), isNull(events.cancelledAt)))
    .orderBy(asc(events.startsAt))
    .limit(limit);
}
