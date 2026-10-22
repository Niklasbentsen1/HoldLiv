// Revisionslog. Logningen må aldrig vælte selve handlingen, så fejl her sluges (men skrives til konsollen).
import { and, desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLog, profiles, users } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";

export interface AuditEntry {
  action: string;
  clubId?: string | null;
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

type Writer = Pick<Db, "insert">;

export async function logAudit(db: Writer, e: AuditEntry) {
  try {
    await db.insert(auditLog).values({
      action: e.action,
      clubId: e.clubId ?? null,
      actorUserId: e.actorUserId ?? null,
      targetType: e.targetType ?? null,
      targetId: e.targetId ?? null,
      detail: e.detail ?? null,
    });
  } catch (err) {
    console.error("Revisionslog fejlede", err);
  }
}

export const AUDIT_PAGE = 50;

/** Foreningens log, nyeste først. Kun foreningens admin kan se den. */
export async function listAudit(db: Db, ctx: AccessContext, clubId: string, before?: Date) {
  assertCan(ctx, { action: "club.manage", clubId });
  const rows = await db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      detail: auditLog.detail,
      actorEmail: users.email,
      actorName: profiles.firstName,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(auditLog.clubId, clubId), before ? lt(auditLog.at, before) : undefined))
    .orderBy(desc(auditLog.at))
    .limit(AUDIT_PAGE + 1);
  return { rows: rows.slice(0, AUDIT_PAGE), more: rows.length > AUDIT_PAGE };
}

export const AUDIT_LABELS: Record<string, string> = {
  "login.ok": "Loggede ind",
  "members.imported": "Importerede medlemmer",
  "arrears.block": "Rettede spærring ved restance",
  "signup.settings": "Rettede indstillinger for online indmeldelse",
  "signup.approved": "Godkendte en ansøgning om medlemskab",
  "signup.rejected": "Afviste en ansøgning om medlemskab",
  "login.mfa_failed": "Forkert to-faktorkode",
  "mfa.enabled": "Slog to-faktor til",
  "mfa.disabled": "Slog to-faktor fra",
  "mfa.recovery_used": "Brugte en nødkode",
  "club.admin_granted": "Gjorde til admin",
  "club.admin_revoked": "Fjernede som admin",
  "club.treasurer_granted": "Udpegede kasserer",
  "club.treasurer_revoked": "Fjernede som kasserer",
  "club.member_added": "Tilføjede medlem",
  "member.updated": "Rettede medlemskab",
  "members.exported": "Eksporterede medlemslisten",
  "fee.created": "Oprettede kontingent",
  "fee.updated": "Rettede kontingent",
  "charges.run": "Kørte opkrævninger",
  "ai.advice": "Bad om en AI-anbefaling til holdplanlægning",
  "charge.manual_payment": "Registrerede kontant betaling",
  "charge.cancelled": "Annullerede opkrævning",
  "charge.refunded": "Refunderede betaling",
};
