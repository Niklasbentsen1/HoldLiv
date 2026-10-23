// Dokumentarkiv: foreningens vedtægter, referater, regler og budgetter samlet ét sted.
//
// Regler:
//   - Hvert dokument har en målgruppe: hele foreningen (alle medlemmer og forældre), et hold (spillere, forældre, trænere)
//     eller bestyrelsen (admin og kasserer).
//   - Admin lægger dokumenter op overalt. Kassereren lægger op til foreningen og bestyrelsen. En træner lægger op til sit eget hold.
//   - Filtypen findes ud fra filens indhold, ikke browserens påstand: PDF, billeder, Word og Excel. Højst 10 MB pr. fil og
//     200 MB i alt pr. forening.
//   - Et dokument kan få en ny version (filen erstattes) og kan slettes; en slettet fil er væk, men sporet står i loggen.
//   - Filerne vises aldrig direkte på siden, men hentes som download uden aktivt indhold.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubDocuments, clubs, teams } from "../db/schema";
import { ForbiddenError, assertCan, type AccessContext } from "../auth/permissions";
import { myScopes } from "./posts";
import { logAudit } from "./audit";

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

export type DocumentAudience = "club" | "team" | "board";
export const AUDIENCE_LABEL: Record<DocumentAudience, string> = { club: "Hele foreningen", team: "Holdet", board: "Bestyrelsen og kassereren" };

const TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** Finder filtypen ud fra de første bytes. Word og Excel er zip-filer, så der kræves også den rigtige endelse. */
export function sniffDocument(bytes: Uint8Array, fileName: string): string | null {
  const at = (i: number, ...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return TYPES.jpg;
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return TYPES.png;
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return TYPES.webp;
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return TYPES.pdf;
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) {
    const ext = fileName.toLowerCase().split(".").pop();
    // Word og Excel er zip-filer med faste mapper; en vilkårlig zip med den rigtige endelse afvises.
    const has = (s: string) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(s);
    if (ext === "docx" && has("word/")) return TYPES.docx;
    if (ext === "xlsx" && has("xl/")) return TYPES.xlsx;
  }
  return null;
}

export interface DocumentInput {
  audience: DocumentAudience;
  /** Kræves, når målgruppen er et hold. */
  teamId?: string | null;
  title: string;
  description?: string | null;
  category?: string | null;
  fileName: string;
  bytes: Uint8Array;
}

async function assertMayUpload(db: Db, ctx: AccessContext, clubId: string, audience: DocumentAudience, teamId: string | null) {
  if (audience === "team") {
    if (!teamId) throw new Error("Vælg et hold.");
    const [t] = await db.select({ clubId: teams.clubId }).from(teams).where(eq(teams.id, teamId));
    if (!t || t.clubId !== clubId) throw new Error("Holdet hører ikke til foreningen.");
    assertCan(ctx, { action: "team.manage", team: { teamId, clubId } });
  } else if (ctx.adminClubs.has(clubId) || ctx.treasurerClubs.has(clubId)) {
    // Admin og kasserer lægger op til foreningen og bestyrelsen.
  } else {
    throw new ForbiddenError("club.manage");
  }
}

function checkFile(input: { fileName: string; bytes: Uint8Array }) {
  if (input.bytes.length === 0) throw new Error("Vælg en fil.");
  if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new Error("Filen må højst fylde 10 MB.");
  const contentType = sniffDocument(input.bytes, input.fileName);
  if (!contentType) throw new Error("Filen skal være en PDF, et billede (JPG, PNG, WebP), et Word-dokument (.docx) eller et Excel-ark (.xlsx).");
  return contentType;
}

const cleanName = (n: string) => n.replace(/[\\/\r\n"]/g, "_").trim().slice(-120) || "dokument";

async function archiveBytes(db: Pick<Db, "select">, clubId: string) {
  const [r] = await db
    .select({ n: sql<number>`coalesce(sum(${clubDocuments.size}), 0)::bigint` })
    .from(clubDocuments)
    .where(and(eq(clubDocuments.clubId, clubId), isNull(clubDocuments.deletedAt)));
  return Number(r.n);
}

export async function uploadDocument(db: Db, ctx: AccessContext, clubId: string, input: DocumentInput) {
  const teamId = input.audience === "team" ? input.teamId || null : null;
  await assertMayUpload(db, ctx, clubId, input.audience, teamId);
  const title = input.title.trim();
  if (!title) throw new Error("Giv dokumentet en titel.");
  if (title.length > 120) throw new Error("Titlen må højst være på 120 tegn.");
  const category = input.category?.trim().slice(0, 40) || null;
  const contentType = checkFile(input);
  if ((await archiveBytes(db, clubId)) + input.bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Arkivet er fyldt (200 MB). Slet gamle dokumenter først.");
  const [doc] = await db
    .insert(clubDocuments)
    .values({
      clubId,
      teamId,
      audience: input.audience,
      title,
      description: input.description?.trim() || null,
      category,
      fileName: cleanName(input.fileName),
      contentType,
      size: input.bytes.length,
      data: Buffer.from(input.bytes),
      uploadedByUserId: ctx.userId,
    })
    .returning({ id: clubDocuments.id });
  await logAudit(db, { action: "document.uploaded", clubId, actorUserId: ctx.userId, targetType: "club_document", targetId: doc.id });
  return doc;
}

async function loadDocument(db: Pick<Db, "select">, documentId: string) {
  const [d] = await db.select().from(clubDocuments).where(and(eq(clubDocuments.id, documentId), isNull(clubDocuments.deletedAt)));
  if (!d) throw new Error("Dokumentet findes ikke.");
  return d;
}

/** Må login'et se dokumentet? Via foreningen, holdet (selv eller børn) eller som administrator/kasserer. */
async function mayView(db: Db, ctx: AccessContext, d: { clubId: string; teamId: string | null; audience: DocumentAudience }) {
  if (ctx.adminClubs.has(d.clubId)) return true;
  if (d.audience === "board") return ctx.treasurerClubs.has(d.clubId);
  const scopes = await myScopes(db, ctx);
  const key = d.audience === "team" ? `team:${d.teamId}` : `club:${d.clubId}`;
  return scopes.some((s) => s.key === key) || (d.audience === "club" && ctx.treasurerClubs.has(d.clubId));
}

/** Må login'et ændre og slette dokumentet? Samme regler som at lægge det op. */
async function mayManage(db: Db, ctx: AccessContext, d: { clubId: string; teamId: string | null; audience: DocumentAudience }) {
  try {
    await assertMayUpload(db, ctx, d.clubId, d.audience, d.teamId);
    return true;
  } catch {
    return false;
  }
}

/** Dokumenter, man må se, grupperet af kalderen. Ikke selve filen. */
export async function listDocuments(db: Db, ctx: AccessContext) {
  const scopes = await myScopes(db, ctx);
  const clubIds = new Set([...scopes.map((s) => s.clubId), ...ctx.adminClubs, ...ctx.treasurerClubs]);
  if (clubIds.size === 0) return [];
  const rows = await db
    .select({
      id: clubDocuments.id,
      clubId: clubDocuments.clubId,
      teamId: clubDocuments.teamId,
      audience: clubDocuments.audience,
      title: clubDocuments.title,
      description: clubDocuments.description,
      category: clubDocuments.category,
      fileName: clubDocuments.fileName,
      contentType: clubDocuments.contentType,
      size: clubDocuments.size,
      version: clubDocuments.version,
      updatedAt: clubDocuments.updatedAt,
      teamName: teams.name,
    })
    .from(clubDocuments)
    .leftJoin(teams, eq(teams.id, clubDocuments.teamId))
    .where(and(inArray(clubDocuments.clubId, [...clubIds]), isNull(clubDocuments.deletedAt)))
    .orderBy(asc(clubDocuments.category), desc(clubDocuments.updatedAt));
  const out = [];
  for (const r of rows) {
    if (!(await mayView(db, ctx, r))) continue;
    out.push({ ...r, canManage: await mayManage(db, ctx, r) });
  }
  return out;
}

/** Filen til en download. Kaster ForbiddenError, hvis man ikke må se dokumentet. */
export async function getDocumentFile(db: Db, ctx: AccessContext, documentId: string) {
  const d = await loadDocument(db, documentId);
  if (!(await mayView(db, ctx, d))) throw new ForbiddenError("club.view");
  return { fileName: d.fileName, contentType: d.contentType, data: d.data };
}

/** Erstat filen med en ny version. Målgruppen er den samme. */
export async function replaceDocumentFile(db: Db, ctx: AccessContext, documentId: string, input: { fileName: string; bytes: Uint8Array }) {
  const d = await loadDocument(db, documentId);
  await assertMayUpload(db, ctx, d.clubId, d.audience, d.teamId);
  const contentType = checkFile(input);
  if ((await archiveBytes(db, d.clubId)) - d.size + input.bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Arkivet er fyldt (200 MB). Slet gamle dokumenter først.");
  await db
    .update(clubDocuments)
    .set({ fileName: cleanName(input.fileName), contentType, size: input.bytes.length, data: Buffer.from(input.bytes), version: sql`${clubDocuments.version} + 1`, updatedAt: ctx.now })
    .where(eq(clubDocuments.id, documentId));
  await logAudit(db, { action: "document.replaced", clubId: d.clubId, actorUserId: ctx.userId, targetType: "club_document", targetId: documentId });
}

export async function updateDocumentInfo(db: Db, ctx: AccessContext, documentId: string, input: { title: string; description?: string | null; category?: string | null }) {
  const d = await loadDocument(db, documentId);
  await assertMayUpload(db, ctx, d.clubId, d.audience, d.teamId);
  const title = input.title.trim();
  if (!title) throw new Error("Giv dokumentet en titel.");
  if (title.length > 120) throw new Error("Titlen må højst være på 120 tegn.");
  await db
    .update(clubDocuments)
    .set({ title, description: input.description?.trim() || null, category: input.category?.trim().slice(0, 40) || null, updatedAt: ctx.now })
    .where(eq(clubDocuments.id, documentId));
}

/** Sletter dokumentet og filen, så pladsen frigives. */
export async function deleteDocument(db: Db, ctx: AccessContext, documentId: string) {
  const d = await loadDocument(db, documentId);
  await assertMayUpload(db, ctx, d.clubId, d.audience, d.teamId);
  await db.update(clubDocuments).set({ deletedAt: ctx.now, data: Buffer.alloc(0), size: 0 }).where(eq(clubDocuments.id, documentId));
  await logAudit(db, { action: "document.deleted", clubId: d.clubId, actorUserId: ctx.userId, targetType: "club_document", targetId: documentId });
}

/** Foreninger og hold, man må lægge dokumenter op til. Til formularen. */
export async function listDocumentTargets(db: Db, ctx: AccessContext) {
  const clubIds = [...new Set([...ctx.adminClubs, ...ctx.treasurerClubs])];
  const [clubRows, scopes] = await Promise.all([clubIds.length ? db.select({ id: clubs.id, name: clubs.name }).from(clubs).where(inArray(clubs.id, clubIds)) : [], myScopes(db, ctx)]);
  const teamsLed = scopes.filter((s) => s.teamId && s.lead);
  return { clubs: clubRows, teams: teamsLed.map((t) => ({ id: t.teamId!, clubId: t.clubId, name: t.label })) };
}
