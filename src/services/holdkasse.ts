// Holdkasse (modul "teamfund"): holdets egen kasse med indbetalinger, udgifter, saldo og historik.
//
// Regler:
//   - Beløbene bestemmer holdet selv. HoldLiv har ingen standardbeløb.
//   - Kun trænere og admin bogfører og annullerer. Hele holdet (og forældrene) ser saldo og poster.
//   - Navnet på en indbetaler ses kun af trænere og admin, og kun hvis de har angivet det.
//   - Poster slettes aldrig. En fejl rettes ved at annullere posten; historikken bliver stående.
//   - Kassen kan ikke gå i minus: en udgift større end saldoen afvises.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { profiles, teamFundEntries, teamMembers, teams } from "../db/schema";
import { can, type AccessContext } from "../auth/permissions";
import { addDays, localDate } from "../lib/money";
import { requireModule } from "./modules";
import { logAudit } from "./audit";

/** Teknisk øvre grænse pr. post, så en tastefejl ikke ødelægger kassen. 100.000 kr. */
export const MAX_FUND_ENTRY_ORE = 10_000_000;
const MAX_BACKDATE_DAYS = 400;

export interface FundEntryInput {
  kind: "deposit" | "withdrawal";
  amountOre: number;
  description: string;
  /** Hvem der har betalt ind (kun ved indbetaling). */
  profileId?: string | null;
  /** Dato for posten, standard i dag. Ikke i fremtiden. */
  entryDate?: string | null;
}

const leads = (ctx: AccessContext, team: { teamId: string; clubId: string }) => can(ctx, { action: "team.manage", team });

export async function addFundEntry(db: Db, ctx: AccessContext, teamId: string, input: FundEntryInput) {
  const { team } = await requireModule(db, ctx, teamId, "teamfund");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer bogfører i holdkassen.");
  if (input.kind !== "deposit" && input.kind !== "withdrawal") throw new Error("Vælg indbetaling eller udgift.");
  if (!Number.isInteger(input.amountOre) || input.amountOre < 1 || input.amountOre > MAX_FUND_ENTRY_ORE) {
    throw new Error("Beløbet skal være mellem 0,01 og 100.000 kr.");
  }
  const description = input.description.trim();
  if (!description) throw new Error("Skriv hvad posten er for.");
  if (description.length > 200) throw new Error("Teksten må højst være på 200 tegn.");
  const today = localDate(ctx.now);
  const entryDate = input.entryDate || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || Number.isNaN(new Date(`${entryDate}T00:00:00Z`).getTime())) throw new Error("Vælg en gyldig dato.");
  if (entryDate > today) throw new Error("Datoen ligger i fremtiden.");
  if (entryDate < addDays(today, -MAX_BACKDATE_DAYS)) throw new Error("Datoen ligger for langt tilbage.");

  let profileId: string | null = null;
  if (input.profileId) {
    if (input.kind !== "deposit") throw new Error("Kun en indbetaling kan knyttes til en spiller.");
    const [m] = await db
      .select({ id: teamMembers.profileId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, input.profileId)));
    if (!m) throw new Error("Personen er ikke på holdet.");
    profileId = input.profileId;
  }

  return db.transaction(async (tx) => {
    // Lås holdet, så to samtidige udgifter ikke begge får lov at tømme den samme saldo.
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
    if (input.kind === "withdrawal") {
      const balance = await balanceOf(tx, teamId);
      if (input.amountOre > balance) throw new Error("Der er ikke penge nok i kassen til den udgift.");
    }
    const [row] = await tx
      .insert(teamFundEntries)
      .values({ teamId, kind: input.kind, amountOre: input.amountOre, description, profileId, entryDate, createdByUserId: ctx.userId })
      .returning();
    await logAudit(tx, { action: "teamfund.entry_added", clubId: team.clubId, actorUserId: ctx.userId, targetType: "team_fund_entry", targetId: row.id });
    return row;
  });
}

/** Annuller en post (fx en tastefejl). Annullerer man en indbetaling, må saldoen ikke blive negativ. */
export async function cancelFundEntry(db: Db, ctx: AccessContext, entryId: string) {
  const [entry] = await db.select().from(teamFundEntries).where(eq(teamFundEntries.id, entryId));
  if (!entry) throw new Error("Posten findes ikke.");
  const { team } = await requireModule(db, ctx, entry.teamId, "teamfund");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer annullerer poster.");
  await db.transaction(async (tx) => {
    await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, entry.teamId)).for("update");
    const [fresh] = await tx.select().from(teamFundEntries).where(eq(teamFundEntries.id, entryId));
    if (fresh.cancelledAt) throw new Error("Posten er allerede annulleret.");
    if (fresh.kind === "deposit" && (await balanceOf(tx, entry.teamId)) < fresh.amountOre) {
      throw new Error("Indbetalingen er allerede brugt, så den kan ikke annulleres. Annuller først de udgifter, der er afholdt for pengene.");
    }
    await tx.update(teamFundEntries).set({ cancelledAt: ctx.now, cancelledByUserId: ctx.userId }).where(eq(teamFundEntries.id, entryId));
    await logAudit(tx, { action: "teamfund.entry_cancelled", clubId: team.clubId, actorUserId: ctx.userId, targetType: "team_fund_entry", targetId: entryId });
  });
}

async function balanceOf(db: Pick<Db, "select">, teamId: string) {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(case when ${teamFundEntries.kind} = 'deposit' then ${teamFundEntries.amountOre} else -${teamFundEntries.amountOre} end), 0)::int` })
    .from(teamFundEntries)
    .where(and(eq(teamFundEntries.teamId, teamId), isNull(teamFundEntries.cancelledAt)));
  return r.n;
}

/** Kassen: saldo, indbetalt og brugt i alt, og posterne (nyeste først). Navne på indbetalere kun for trænere og admin. */
export async function getTeamFund(db: Db, ctx: AccessContext, teamId: string) {
  const { team } = await requireModule(db, ctx, teamId, "teamfund");
  const lead = leads(ctx, team);
  const rows = await db
    .select({ e: teamFundEntries, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(teamFundEntries)
    .leftJoin(profiles, eq(profiles.id, teamFundEntries.profileId))
    .where(eq(teamFundEntries.teamId, teamId))
    .orderBy(desc(teamFundEntries.entryDate), desc(teamFundEntries.createdAt))
    .limit(300);
  // Summerne regnes over alle poster, ikke kun de viste.
  const [sums] = await db
    .select({
      deposited: sql<number>`coalesce(sum(case when ${teamFundEntries.kind} = 'deposit' then ${teamFundEntries.amountOre} else 0 end), 0)::int`,
      spent: sql<number>`coalesce(sum(case when ${teamFundEntries.kind} = 'withdrawal' then ${teamFundEntries.amountOre} else 0 end), 0)::int`,
    })
    .from(teamFundEntries)
    .where(and(eq(teamFundEntries.teamId, teamId), isNull(teamFundEntries.cancelledAt)));
  const players = lead
    ? await db
        .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
        .from(teamMembers)
        .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))
        .orderBy(profiles.firstName)
    : [];
  return {
    canManage: lead,
    depositedOre: sums.deposited,
    spentOre: sums.spent,
    balanceOre: sums.deposited - sums.spent,
    entries: rows.map((r) => ({
      id: r.e.id,
      kind: r.e.kind,
      amountOre: r.e.amountOre,
      description: r.e.description,
      entryDate: r.e.entryDate,
      cancelled: !!r.e.cancelledAt,
      payerName: lead && r.firstName ? `${r.firstName} ${r.lastName}` : null,
    })),
    players: players.map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}` })),
  };
}
