// Selvbetjent oprettelse af en ny forening og guiden "Kom i gang". Den der opretter, bliver foreningens første admin.
// HoldLiv tager ikke betaling her; abonnement og pris er ikke besluttet.
import { and, count, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubRoles, clubs, teams } from "../db/schema";
import type { AccessContext } from "../auth/permissions";
import { logAudit } from "./audit";
import { createClub } from "./index";

export const MAX_CLUB_NAME = 80;
/** Mod misbrug: én person kan højst oprette så mange foreninger selv. */
export const MAX_CLUBS_PER_CREATOR = 3;
const RESERVED_SLUGS = new Set(["admin", "api", "app", "hjaelp", "holdliv", "login", "www", "support", "demo", "test"]);

/** "Skovby Idrætsforening!" -> "skovby-idraetsforening" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

export function checkSlug(slug: string): string | null {
  if (slug.length < 3) return "Adressen skal være mindst 3 tegn.";
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 50) return "Adressen må kun have små bogstaver (a-z), tal og bindestreg.";
  if (RESERVED_SLUGS.has(slug)) return "Den adresse er reserveret. Vælg en anden.";
  return null;
}

export async function isSlugFree(db: Pick<Db, "select">, slug: string) {
  const [c] = await db.select({ id: clubs.id }).from(clubs).where(eq(clubs.slug, slug));
  return !c;
}

/** Opretter foreningen og gør den loggede ind til første admin. Kræver et login med profil, men ingen rettigheder på forhånd. */
export async function registerClub(db: Db, ctx: AccessContext, input: { name: string; slug?: string | null }) {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Skriv foreningens navn.");
  if (name.length > MAX_CLUB_NAME) throw new Error(`Navnet må højst være ${MAX_CLUB_NAME} tegn.`);
  const slug = (input.slug?.trim() || slugify(name)).toLowerCase();
  const bad = checkSlug(slug);
  if (bad) throw new Error(bad);
  if (ctx.adminClubs.size >= MAX_CLUBS_PER_CREATOR) throw new Error(`Du kan højst oprette ${MAX_CLUBS_PER_CREATOR} foreninger selv. Skriv til os, hvis du har brug for flere.`);
  if (!(await isSlugFree(db, slug))) throw new Error("Den adresse er optaget. Vælg en anden.");
  let club;
  try {
    club = await createClub(db, ctx, name, slug);
  } catch (e) {
    // To der opretter samme adresse på samme tid: den sidste rammer unik-nøglen.
    if (!(await isSlugFree(db, slug))) throw new Error("Den adresse er optaget. Vælg en anden.");
    throw e;
  }
  await logAudit(db, { action: "club.registered", clubId: club.id, actorUserId: ctx.userId, detail: { slug } });
  return club;
}

export interface OnboardingStep {
  key: string;
  title: string;
  text: string;
  href: string;
  done: boolean;
}

/** Guiden "Kom i gang": hvad er gjort, og hvad mangler. Kun foreningens admin. */
export async function onboardingSteps(db: Db, ctx: AccessContext, clubId: string): Promise<OnboardingStep[]> {
  if (!ctx.adminClubs.has(clubId)) throw new Error("Kun foreningens administratorer har adgang her.");
  const [club] = await db.select().from(clubs).where(eq(clubs.id, clubId));
  const [{ n: teamCount }] = await db.select({ n: count() }).from(teams).where(eq(teams.clubId, clubId));
  const [{ n: memberCount }] = await db.select({ n: count() }).from(clubMemberships).where(eq(clubMemberships.clubId, clubId));
  const [{ n: adminCount }] = await db.select({ n: count() }).from(clubRoles).where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.role, "admin")));
  const q = `?klub=${clubId}`;
  return [
    { key: "teams", title: "Opret jeres hold", text: "Et hold pr. årgang eller afdeling. Hvert hold får et invitationslink, som trænere og forældre bruger.", href: `/forening${q}`, done: teamCount > 0 },
    { key: "import", title: "Flyt jeres medlemmer", text: "Importér en liste fra Excel, Klubmodul eller Holdsport. Det er gratis, og du ser resultatet, før noget gemmes.", href: `/forening/import${q}`, done: memberCount > 1 },
    { key: "admins", title: "Tilføj en medadministrator", text: "Så foreningen ikke hænger på én person. Foreningen skal altid have mindst én admin.", href: `/forening${q}`, done: adminCount > 1 },
    { key: "signup", title: "Åbn for online indmeldelse", text: "Nye medlemmer melder sig ind via et link, og du godkender dem.", href: `/forening/tilmeldinger${q}`, done: club.signupEnabled },
    { key: "site", title: "Tænd foreningens hjemmeside", text: "En offentlig side med hold, kommende aktiviteter og indmeldelse.", href: `/forening/hjemmeside${q}`, done: club.siteEnabled },
    { key: "payments", title: "Gør klar til kontingent", text: "Opret kontingenter med jeres egne priser, og forbind foreningens Stripe-konto.", href: `/kasse/kontingenter${q}`, done: !!club.stripeAccountId },
  ];
}
