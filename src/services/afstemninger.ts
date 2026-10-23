// Afstemninger (modul "polls"): hurtige afstemninger på et hold.
//
// Regler:
//   - Trænere og admin starter, lukker og sletter afstemninger. 2 til 10 valgmuligheder, som ikke kan ændres, når den er startet.
//   - Én stemme pr. spiller (eller træner) på holdet. En forælder stemmer for sit barn; barnets stemme er fælles for værgerne.
//     Man kan skifte sin stemme, til afstemningen lukker.
//   - Afstemningen lukker ved sluttidspunktet (hvis der er et) eller når en træner lukker den.
//   - Resultatet vises, når man har stemt, eller afstemningen er lukket. Trænerne ser det altid.
//   - Hvem der har stemt hvad ses kun af trænerne, og slet ikke i en anonym afstemning.
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { pollOptions, pollVotes, polls, profiles, teamMembers } from "../db/schema";
import { can, canActAs, type AccessContext } from "../auth/permissions";
import { requireModule } from "./modules";
import { logAudit } from "./audit";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
const MAX_DAYS_OPEN = 180;

export interface PollInput {
  question: string;
  description?: string | null;
  options: string[];
  multiple?: boolean;
  anonymous?: boolean;
  closesAt?: Date | null;
}

const leads = (ctx: AccessContext, team: { teamId: string; clubId: string }) => can(ctx, { action: "team.manage", team });
const isOpen = (p: { closedAt: Date | null; closesAt: Date | null }, now: Date) => !p.closedAt && (!p.closesAt || p.closesAt.getTime() > now.getTime());

export async function createPoll(db: Db, ctx: AccessContext, teamId: string, input: PollInput, deliver?: Deliver) {
  const { team } = await requireModule(db, ctx, teamId, "polls");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer starter afstemninger.");
  const question = input.question.trim();
  if (!question) throw new Error("Skriv et spørgsmål.");
  if (question.length > 200) throw new Error("Spørgsmålet må højst være på 200 tegn.");
  const labels = input.options.map((o) => o.trim()).filter(Boolean);
  if (labels.length < MIN_OPTIONS || labels.length > MAX_OPTIONS) throw new Error(`En afstemning skal have fra ${MIN_OPTIONS} til ${MAX_OPTIONS} valgmuligheder.`);
  if (labels.some((l) => l.length > 100)) throw new Error("En valgmulighed må højst være på 100 tegn.");
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw new Error("Valgmulighederne skal være forskellige.");
  const closesAt = input.closesAt ?? null;
  if (closesAt) {
    if (Number.isNaN(closesAt.getTime())) throw new Error("Vælg et gyldigt sluttidspunkt.");
    if (closesAt.getTime() <= ctx.now.getTime()) throw new Error("Sluttidspunktet ligger i fortiden.");
    if (closesAt.getTime() > ctx.now.getTime() + MAX_DAYS_OPEN * 86400000) throw new Error("En afstemning kan højst være åben i et halvt år.");
  }
  const poll = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(polls)
      .values({ teamId, question, description: input.description?.trim() || null, multiple: !!input.multiple, anonymous: !!input.anonymous, closesAt, createdByUserId: ctx.userId })
      .returning();
    await tx.insert(pollOptions).values(labels.map((label, position) => ({ pollId: p.id, label, position })));
    await logAudit(tx, { action: "poll.created", clubId: team.clubId, actorUserId: ctx.userId, targetType: "poll", targetId: p.id });
    return p;
  });
  if (deliver) {
    const members = await db.select({ profileId: teamMembers.profileId }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
    const recipients = await recipientsOfPlayers(db, members.map((m) => m.profileId), ctx.now);
    await notifyUsers(db, deliver, recipients.filter((r) => r.userId !== ctx.userId), {
      kind: "poll",
      subject: `Ny afstemning: ${question}`,
      body: `Der er en ny afstemning på holdet: ${question}`,
      sms: `Ny afstemning: ${question}`,
      url: `/hold/${teamId}/afstemninger`,
      dedupeKey: `poll:${poll.id}:new`,
    });
  }
  return poll;
}

async function loadPoll(db: Pick<Db, "select">, pollId: string) {
  const [p] = await db.select().from(polls).where(eq(polls.id, pollId));
  if (!p) throw new Error("Afstemningen findes ikke.");
  return p;
}

export async function closePoll(db: Db, ctx: AccessContext, pollId: string) {
  const p = await loadPoll(db, pollId);
  const { team } = await requireModule(db, ctx, p.teamId, "polls");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer lukker afstemninger.");
  if (!isOpen(p, ctx.now)) throw new Error("Afstemningen er allerede lukket.");
  await db.update(polls).set({ closedAt: ctx.now }).where(eq(polls.id, pollId));
  await logAudit(db, { action: "poll.closed", clubId: team.clubId, actorUserId: ctx.userId, targetType: "poll", targetId: pollId });
}

/** Sletter afstemningen og alle stemmer. */
export async function deletePoll(db: Db, ctx: AccessContext, pollId: string) {
  const p = await loadPoll(db, pollId);
  const { team } = await requireModule(db, ctx, p.teamId, "polls");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer sletter afstemninger.");
  await db.delete(polls).where(eq(polls.id, pollId));
  await logAudit(db, { action: "poll.deleted", clubId: team.clubId, actorUserId: ctx.userId, targetType: "poll", targetId: pollId });
}

/** Afgiv (eller skift) stemmen for en spiller på holdet. Egen profil som standard; en forælder angiver barnets profil. */
export async function vote(db: Db, ctx: AccessContext, pollId: string, optionIds: string[], profileId?: string) {
  const target = profileId ?? ctx.profileId;
  if (!canActAs(ctx, target)) throw new Error("Du kan kun stemme for dig selv og dine børn.");
  const p = await loadPoll(db, pollId);
  await requireModule(db, ctx, p.teamId, "polls");
  const [member] = await db.select({ id: teamMembers.profileId }).from(teamMembers).where(and(eq(teamMembers.teamId, p.teamId), eq(teamMembers.profileId, target)));
  if (!member) throw new Error("Kun medlemmer af holdet kan stemme.");
  const chosen = [...new Set(optionIds)];
  if (chosen.length === 0) throw new Error("Vælg mindst ét svar.");
  if (!p.multiple && chosen.length > 1) throw new Error("Du kan kun vælge ét svar.");
  await db.transaction(async (tx) => {
    // Lås afstemningen, så lukning og stemmer ikke kan overhale hinanden.
    const [fresh] = await tx.select().from(polls).where(eq(polls.id, pollId)).for("update");
    if (!fresh || !isOpen(fresh, ctx.now)) throw new Error("Afstemningen er lukket.");
    const valid = await tx.select({ id: pollOptions.id }).from(pollOptions).where(and(eq(pollOptions.pollId, pollId), inArray(pollOptions.id, chosen)));
    if (valid.length !== chosen.length) throw new Error("Et af svarene hører ikke til afstemningen.");
    await tx.delete(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.profileId, target)));
    await tx.insert(pollVotes).values(chosen.map((optionId) => ({ pollId, optionId, profileId: target, votedByUserId: ctx.userId })));
  });
}

/** Træk sin stemme tilbage, mens afstemningen er åben. */
export async function withdrawVote(db: Db, ctx: AccessContext, pollId: string, profileId?: string) {
  const target = profileId ?? ctx.profileId;
  if (!canActAs(ctx, target)) throw new Error("Du kan kun stemme for dig selv og dine børn.");
  const p = await loadPoll(db, pollId);
  await requireModule(db, ctx, p.teamId, "polls");
  if (!isOpen(p, ctx.now)) throw new Error("Afstemningen er lukket.");
  await db.delete(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.profileId, target)));
}

/**
 * Afstemningerne på holdet med resultater og egne stemmer.
 * `voters` er de profiler, man selv kan stemme for (sig selv og sine børn) og som er på holdet.
 */
export async function listPolls(db: Db, ctx: AccessContext, teamId: string) {
  const { team } = await requireModule(db, ctx, teamId, "polls");
  const lead = leads(ctx, team);
  const rows = await db.select().from(polls).where(eq(polls.teamId, teamId)).orderBy(desc(polls.createdAt)).limit(50);
  const ids = rows.map((r) => r.id);
  const [options, votes, members] = await Promise.all([
    ids.length ? db.select().from(pollOptions).where(inArray(pollOptions.pollId, ids)).orderBy(asc(pollOptions.position)) : [],
    ids.length
      ? db
          .select({ v: pollVotes, firstName: profiles.firstName, lastName: profiles.lastName })
          .from(pollVotes)
          .innerJoin(profiles, eq(profiles.id, pollVotes.profileId))
          .where(inArray(pollVotes.pollId, ids))
      : [],
    db
      .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(eq(teamMembers.teamId, teamId)),
  ]);
  const memberIds = new Set(members.map((m) => m.id));
  const voters = members.filter((m) => canActAs(ctx, m.id)).map((m) => ({ profileId: m.id, name: `${m.firstName} ${m.lastName}`, self: m.id === ctx.profileId }));
  // Trænere kan også ses som medlemmer; antal mulige stemmer er hele holdet.
  const eligible = memberIds.size;

  return {
    canManage: lead,
    voters,
    polls: rows.map((p) => {
      const open = isOpen(p, ctx.now);
      const pVotes = votes.filter((v) => v.v.pollId === p.id);
      const myVotes = pVotes.filter((v) => canActAs(ctx, v.v.profileId));
      const hasVoted = voters.map((vt) => ({ profileId: vt.profileId, optionIds: myVotes.filter((v) => v.v.profileId === vt.profileId).map((v) => v.v.optionId) }));
      const showResults = lead || !open || hasVoted.some((h) => h.optionIds.length > 0);
      const voterCount = new Set(pVotes.map((v) => v.v.profileId)).size;
      return {
        id: p.id,
        question: p.question,
        description: p.description,
        multiple: p.multiple,
        anonymous: p.anonymous,
        open,
        closesAt: p.closesAt,
        showResults,
        eligible,
        voterCount: showResults ? voterCount : null,
        myVotes: hasVoted,
        options: options
          .filter((o) => o.pollId === p.id)
          .map((o) => {
            const forOption = pVotes.filter((v) => v.v.optionId === o.id);
            return {
              id: o.id,
              label: o.label,
              count: showResults ? forOption.length : null,
              // Navne kun til trænere og aldrig i en anonym afstemning.
              names: lead && !p.anonymous ? forOption.map((v) => `${v.firstName} ${v.lastName}`).sort() : [],
            };
          }),
      };
    }),
  };
}
