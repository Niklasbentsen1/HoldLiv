// Medlemsimport (eksporten er membersCsv i finance.ts). Filen læses som CSV (Excel gemmer som CSV; Klubmodul og Holdsport kan eksportere medlemslister).
// Kolonner genkendes på overskriften, og foreningen kan rette koblingen, før noget gemmes. Egne kolonner bliver til egne felter.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, guardianships, memberFields, memberFieldValues, profiles, teamMembers, teams } from "../db/schema";
import { assertCan, isMinor, type AccessContext } from "../auth/permissions";
import { parseCsv } from "../lib/csv";
import { logAudit } from "./audit";
import { applyTeamDefaultFee, newInviteCode } from "./teams";

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2_000_000;

export const TARGETS = {
  firstName: "Fornavn",
  lastName: "Efternavn",
  fullName: "Navn (fornavn og efternavn samlet)",
  birthDate: "Fødselsdato",
  email: "E-mail",
  phone: "Telefon",
  team: "Hold / afdeling",
  guardianName: "Forælder: navn",
  guardianEmail: "Forælder: e-mail",
  guardianPhone: "Forælder: telefon",
} as const;
export type Target = keyof typeof TARGETS;
export type ColumnMap = { target: Target | "custom" | "ignore"; name?: string };

const norm = (h: string) => h.toLowerCase().replace(/[^a-zæøå0-9]/g, "");
const ALIASES: Record<Target, string[]> = {
  firstName: ["fornavn", "fornavne", "firstname", "fname", "givenname"],
  lastName: ["efternavn", "lastname", "surname", "familyname"],
  fullName: ["navn", "name", "medlem", "medlemsnavn", "fuldtnavn", "fullname", "spiller"],
  birthDate: ["fødselsdato", "foedselsdato", "fødselsdag", "birthdate", "birthday", "dob", "dateofbirth", "født"],
  email: ["email", "emailadresse", "mail", "mailadresse", "epost"],
  phone: ["telefon", "tlf", "tlfnr", "mobil", "mobilnr", "mobilnummer", "telefonnr", "telefonnummer", "phone", "mobile", "phonenumber"],
  team: ["hold", "afdeling", "afdelinger", "team", "teams", "department", "gruppe", "holdafdeling", "aktivitet"],
  guardianName: ["forælder", "forældernavn", "forælder1", "forælder1navn", "værge", "værgenavn", "kontaktperson", "parent", "parentname", "guardian", "guardianname"],
  guardianEmail: ["forældermail", "forælderemail", "forældersemail", "værgemail", "værgeemail", "kontaktpersonemail", "parentemail", "guardianemail", "forælder1email", "forælder1mail"],
  guardianPhone: ["forældertelefon", "forældertlf", "forældermobil", "forældersmobil", "værgetelefon", "værgemobil", "kontaktpersontlf", "kontaktpersontelefon", "parentphone", "guardianphone", "forælder1telefon", "forælder1mobil"],
};
const ALIAS_LOOKUP = new Map<string, Target>(Object.entries(ALIASES).flatMap(([t, list]) => list.map((a) => [a, t as Target] as const)));

/** Gætter, hvad hver kolonne er. Ukendte kolonner bliver til egne felter, og hver type bruges højst én gang. */
export function detectMapping(headers: string[]): ColumnMap[] {
  const used = new Set<Target>();
  return headers.map((h) => {
    if (norm(h) === "status") return { target: "ignore" };
    const t = ALIAS_LOOKUP.get(norm(h));
    if (t && !used.has(t)) {
      used.add(t);
      return { target: t };
    }
    return h.trim() ? { target: "custom", name: h.trim() } : { target: "ignore" };
  });
}

export function parseDate(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let match: RegExpMatchArray | null;
  if ((match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, m, d] = [+match[1], +match[2], +match[3]];
  else if ((match = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/))) [d, m, y] = [+match[1], +match[2], +match[3]];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d || y < 1900 || date > new Date()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function splitName(full: string): { firstName: string; lastName: string } | null {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Person {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}
export interface ImportRow {
  line: number;
  person: Person;
  birthDate: string | null;
  teams: string[];
  guardian: Person | null;
  custom: Record<string, string>;
  errors: string[];
  warnings: string[];
  status: "new" | "existing" | "duplicate" | "error";
}
export interface ImportReport {
  rows: ImportRow[];
  counts: { new: number; existing: number; duplicate: number; error: number };
  newTeams: string[];
  commit?: { created: number; updated: number; teamsCreated: number };
}

function parseRows(table: string[][], mapping: ColumnMap[]): ImportRow[] {
  const out: ImportRow[] = [];
  for (let i = 1; i < table.length; i++) {
    const cells = table[i];
    const get = (t: Target) => {
      const idx = mapping.findIndex((m) => m.target === t);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const errors: string[] = [];
    const warnings: string[] = [];
    let firstName = get("firstName");
    let lastName = get("lastName");
    if (!firstName && !lastName && get("fullName")) {
      const n = splitName(get("fullName"));
      if (n) ({ firstName, lastName } = n);
    }
    if (!firstName || !lastName) errors.push("Mangler for- og efternavn");
    const rawBirth = get("birthDate");
    const birthDate = parseDate(rawBirth);
    if (rawBirth && !birthDate) errors.push(`Fødselsdatoen "${rawBirth}" kan ikke læses (brug fx 31-12-2015)`);
    const email = get("email").toLowerCase() || null;
    if (email && !EMAIL.test(email)) errors.push(`E-mailen "${email}" er ikke gyldig`);
    const gName = get("guardianName");
    const gEmail = get("guardianEmail").toLowerCase() || null;
    const gPhone = get("guardianPhone") || null;
    let guardian: Person | null = null;
    if (gName || gEmail || gPhone) {
      const n = gName ? splitName(gName) ?? { firstName: gName, lastName: "(forælder)" } : { firstName: "Forælder til", lastName: `${firstName} ${lastName}`.trim() };
      if (gEmail && !EMAIL.test(gEmail)) errors.push(`Forælderens e-mail "${gEmail}" er ikke gyldig`);
      guardian = { ...n, email: gEmail, phone: gPhone };
    }
    if (birthDate && isMinor(birthDate) && !guardian) warnings.push("Barn uden forælder, tilføj en forælder bagefter");
    const custom: Record<string, string> = {};
    mapping.forEach((m, idx) => {
      const v = (cells[idx] ?? "").trim();
      if (m.target === "custom" && m.name?.trim() && v) custom[m.name.trim()] = v;
    });
    out.push({
      line: i + 1,
      person: { firstName, lastName, email, phone: get("phone") || null },
      birthDate,
      teams: [...new Set(get("team").split(/[,;|]/).map((t) => t.trim()).filter(Boolean))],
      guardian,
      custom,
      errors,
      warnings,
      status: errors.length ? "error" : "new",
    });
  }
  return out;
}

const keyOf = (p: Person, birthDate: string | null) => `${p.firstName} ${p.lastName}`.toLowerCase() + "|" + (birthDate ?? p.email ?? "");

/** Læser filen og viser, hvad der vil ske. Med commit gemmes det i én transaktion. Kun foreningens admin. */
export async function runImport(db: Db, ctx: AccessContext, clubId: string, text: string, mapping: ColumnMap[] | null, commit: boolean): Promise<ImportReport & { headers: string[]; mapping: ColumnMap[] }> {
  assertCan(ctx, { action: "club.manage", clubId });
  if (text.length > MAX_IMPORT_BYTES) throw new Error("Filen er for stor. Del den op i flere filer.");
  const table = parseCsv(text);
  if (table.length < 2) throw new Error("Filen skal have en overskriftsrække og mindst ét medlem.");
  if (table.length - 1 > MAX_IMPORT_ROWS) throw new Error(`Højst ${MAX_IMPORT_ROWS} medlemmer ad gangen.`);
  const headers = table[0];
  const map = mapping && mapping.length === headers.length ? mapping : detectMapping(headers);
  if (!map.some((m) => m.target === "firstName" || m.target === "fullName")) throw new Error("Kunne ikke finde en kolonne med navne. Vælg hvilken kolonne der er navn.");
  const rows = parseRows(table, map);

  const existing = await db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, birthDate: profiles.birthDate, email: profiles.email })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(and(eq(clubMemberships.clubId, clubId), isNull(profiles.deletedAt)));
  const existingByKey = new Map(existing.map((e) => [keyOf({ firstName: e.firstName, lastName: e.lastName, email: e.email, phone: null }, e.birthDate), e.id]));
  const clubTeams = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.clubId, clubId));
  const teamByName = new Map(clubTeams.map((t) => [t.name.toLowerCase(), t.id]));

  const seen = new Set<string>();
  const matchIds = new Map<ImportRow, string>();
  for (const r of rows) {
    if (r.status === "error") continue;
    const k = keyOf(r.person, r.birthDate);
    if (seen.has(k)) {
      r.status = "duplicate";
      r.warnings.push("Står flere gange i filen, bruges kun første gang");
      continue;
    }
    seen.add(k);
    const id = existingByKey.get(k);
    if (id) {
      r.status = "existing";
      matchIds.set(r, id);
    }
  }
  const newTeams = [...new Map(rows.filter((r) => r.status !== "error" && r.status !== "duplicate").flatMap((r) => r.teams).filter((t) => !teamByName.has(t.toLowerCase())).map((t) => [t.toLowerCase(), t])).values()];
  const counts = { new: 0, existing: 0, duplicate: 0, error: 0 };
  for (const r of rows) counts[r.status]++;
  const report = { rows, counts, newTeams, headers, mapping: map } as ImportReport & { headers: string[]; mapping: ColumnMap[] };
  if (!commit) return report;
  if (counts.error > 0) throw new Error("Ret fejlene i filen først. Ingen medlemmer er gemt.");

  report.commit = await db.transaction(async (tx) => {
    let created = 0;
    let updated = 0;
    let teamsCreated = 0;
    for (const name of newTeams) {
      const [t] = await tx.insert(teams).values({ clubId, name, inviteCode: newInviteCode() }).returning({ id: teams.id });
      teamByName.set(name.toLowerCase(), t.id);
      teamsCreated++;
    }
    const fieldIds = new Map<string, string>();
    for (const f of await tx.select().from(memberFields).where(eq(memberFields.clubId, clubId))) fieldIds.set(f.name.toLowerCase(), f.id);
    const guardianCache = new Map<string, string>();
    const clubGuardians = await tx
      .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, email: profiles.email })
      .from(guardianships)
      .innerJoin(clubMemberships, and(eq(clubMemberships.profileId, guardianships.childProfileId), eq(clubMemberships.clubId, clubId)))
      .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId));
    // To forskellige forældre med samme navn må ikke slås sammen: uden e-mail eller telefon oprettes en forælder pr. barn.
    const gKey = (g: Person) => (g.email ? `e:${g.email}|${g.firstName.toLowerCase()}` : g.phone ? `p:${g.phone.replace(/\s/g, "")}|${g.firstName} ${g.lastName}`.toLowerCase() : null);
    for (const g of clubGuardians) {
      const k = gKey({ firstName: g.firstName, lastName: g.lastName, email: g.email, phone: null });
      if (k) guardianCache.set(k, g.id);
    }

    for (const r of rows) {
      if (r.status === "duplicate") continue;
      let profileId = matchIds.get(r);
      if (profileId) {
        // Eksisterende medlem: udfyld kun det, der mangler, og overskriv aldrig.
        await tx.update(profiles).set({ email: sql`coalesce(${profiles.email}, ${r.person.email})`, phone: sql`coalesce(${profiles.phone}, ${r.person.phone})` }).where(eq(profiles.id, profileId));
        updated++;
      } else {
        const [p] = await tx.insert(profiles).values({ ...r.person, birthDate: r.birthDate, createdByUserId: ctx.userId }).returning({ id: profiles.id });
        profileId = p.id;
        await tx.insert(clubMemberships).values({ clubId, profileId }).onConflictDoNothing();
        created++;
      }
      if (r.guardian) {
        const gk = gKey(r.guardian);
        let gid = gk ? guardianCache.get(gk) : undefined;
        if (!gid) {
          const [g] = await tx.insert(profiles).values({ ...r.guardian, createdByUserId: ctx.userId }).returning({ id: profiles.id });
          gid = g.id;
          if (gk) guardianCache.set(gk, gid);
        }
        await tx.insert(guardianships).values({ guardianProfileId: gid, childProfileId: profileId }).onConflictDoNothing();
      }
      for (const t of r.teams) {
        const teamId = teamByName.get(t.toLowerCase())!;
        await tx.insert(teamMembers).values({ teamId, profileId, role: "player" }).onConflictDoNothing();
        await applyTeamDefaultFee(tx, teamId, profileId);
      }
      for (const [name, value] of Object.entries(r.custom)) {
        let fieldId = fieldIds.get(name.toLowerCase());
        if (!fieldId) {
          const [f] = await tx.insert(memberFields).values({ clubId, name }).returning({ id: memberFields.id });
          fieldId = f.id;
          fieldIds.set(name.toLowerCase(), fieldId);
        }
        await tx.insert(memberFieldValues).values({ fieldId, profileId, value }).onConflictDoNothing();
      }
    }
    return { created, updated, teamsCreated };
  });
  await logAudit(db, { action: "members.imported", clubId, actorUserId: ctx.userId, detail: { created: report.commit.created, updated: report.commit.updated, rows: rows.length } });
  return report;
}
