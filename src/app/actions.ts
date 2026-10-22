"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canActAs, ForbiddenError } from "../auth/permissions";
import { LoginError, requestLogin, verifyCode } from "../auth/login";
import {
  addCoachByEmail,
  addGuardianByEmail,
  createChildProfile,
  createEvent,
  createEventSeries,
  createProfileForUser,
  createTeam,
  joinTeamByInvite,
  removeTeamMember,
  respondToEvent,
  rotateInviteCode,
  setEventCancelled,
  updateEvent,
  type EventInput,
  cancelCharge,
  completeCheckout,
  connectPayments,
  createFee,
  createSingleCharge,
  getCheckout,
  grantTreasurerByEmail,
  refundCharge,
  registerManualPayment,
  revokeTreasurer,
  runCharges,
  sendReminders,
  setFeeArchived,
  setTeamDefaultFee,
  startCheckout,
  updateFee,
  updateMembership,
} from "../services";
import { parseKr, type FeeInterval } from "../lib/money";
import { getPaymentProvider, mockPaymentsEnabled } from "../lib/payments";
import { db } from "../lib/db";
import { sendLoginMail, sendMail } from "../lib/mail";
import { endSession, getSession, getUserId, requireSession, safeNext, setActingProfile, startSession } from "../lib/session";
import { parseLocalDateTime } from "../lib/time";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || null;

/** Kører en handling og sender tilbage med en læsbar fejl, hvis den fejler. */
async function attempt(back: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const message =
      e instanceof ForbiddenError ? "Det har du ikke adgang til." : e instanceof Error ? e.message : "Noget gik galt.";
    if (!(e instanceof ForbiddenError || e instanceof LoginError)) console.error(e);
    redirect(`${back}${back.includes("?") ? "&" : "?"}fejl=${encodeURIComponent(message)}`);
  }
}

// --- Login ---

async function origin() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function requestLoginAction(formData: FormData) {
  const next = safeNext(str(formData, "next"));
  let email = "";
  await attempt(`/login?next=${encodeURIComponent(next)}`, async () => {
    const r = await requestLogin(db, str(formData, "email"));
    email = r.email;
    const link = `${await origin()}/login/link?token=${r.linkToken}&next=${encodeURIComponent(next)}`;
    await sendLoginMail(r.email, r.code, link);
  });
  redirect(`/login/kode?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`);
}

export async function verifyCodeAction(formData: FormData) {
  const email = str(formData, "email");
  const next = safeNext(str(formData, "next"));
  await attempt(`/login/kode?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`, async () => {
    await startSession(await verifyCode(db, email, str(formData, "code")));
  });
  redirect(next);
}

/** Kun til demoen: log ind som en demoperson uden e-mail. */
export async function demoLogin(formData: FormData) {
  if (process.env.NODE_ENV === "production" && process.env.DEMO_LOGIN !== "1") throw new Error("Demo-login er slået fra");
  await startSession(str(formData, "userId"));
  redirect("/");
}

export async function logout() {
  await endSession();
  redirect("/login");
}

export async function completeProfile(formData: FormData) {
  const userId = await getUserId();
  if (!userId) redirect("/login");
  await attempt("/velkommen", async () => {
    const firstName = str(formData, "firstName");
    const lastName = str(formData, "lastName");
    if (!firstName || !lastName) throw new Error("Skriv både fornavn og efternavn");
    await createProfileForUser(db, userId, { firstName, lastName, phone: opt(formData, "phone"), birthDate: opt(formData, "birthDate") });
  });
  redirect(safeNext(str(formData, "next")));
}

// --- Profilskift og svar ---

export async function switchProfile(formData: FormData) {
  const session = await getSession();
  const profileId = str(formData, "profileId");
  if (session && (profileId === "all" || canActAs(session.ctx, profileId))) await setActingProfile(profileId);
  revalidatePath("/");
}

export async function respond(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, () =>
    respondToEvent(
      db,
      ctx,
      str(formData, "eventId"),
      str(formData, "profileId"),
      str(formData, "status") as "yes" | "no" | "maybe",
      formData.has("comment") ? opt(formData, "comment") : undefined,
    ),
  );
  revalidatePath(back);
}

// --- Familie ---

export async function addChild(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/familie", async () => {
    const birthDate = str(formData, "birthDate");
    if (!birthDate) throw new Error("Skriv barnets fødselsdato");
    await createChildProfile(db, ctx, { firstName: str(formData, "firstName"), lastName: str(formData, "lastName"), birthDate });
  });
  revalidatePath("/familie");
}

export async function addGuardian(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/familie", () => addGuardianByEmail(db, ctx, str(formData, "childId"), str(formData, "email")));
  revalidatePath("/familie");
}

// --- Hold ---

export async function joinTeam(formData: FormData) {
  const { ctx } = await requireSession();
  const code = str(formData, "code");
  const ids = formData.getAll("profileId").map(String);
  let teamId = "";
  await attempt(`/join/${code}`, async () => {
    if (ids.length === 0) throw new Error("Vælg hvem der skal på holdet");
    for (const id of ids) teamId = (await joinTeamByInvite(db, ctx, code, id)).id;
  });
  redirect(`/hold/${teamId}`);
}

export async function newInviteLink(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}`, () => rotateInviteCode(db, ctx, teamId));
  revalidatePath(`/hold/${teamId}`);
}

export async function removePlayer(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}`, () => removeTeamMember(db, ctx, teamId, str(formData, "profileId"), "player"));
  revalidatePath(`/hold/${teamId}`);
}

export async function addCoach(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}`, () => addCoachByEmail(db, ctx, teamId, str(formData, "email")));
  revalidatePath(`/hold/${teamId}`);
}

export async function newTeam(formData: FormData) {
  const { ctx } = await requireSession();
  let teamId = "";
  await attempt("/forening", async () => {
    const name = str(formData, "name");
    if (!name) throw new Error("Skriv holdets navn");
    teamId = (await createTeam(db, ctx, str(formData, "clubId"), name, opt(formData, "season") ?? undefined)).id;
  });
  redirect(`/hold/${teamId}`);
}

// --- Kalender ---

function eventInput(formData: FormData): EventInput {
  const title = str(formData, "title");
  const start = str(formData, "startsAt");
  if (!title || !start) throw new Error("Skriv titel og tidspunkt");
  const startsAt = parseLocalDateTime(start);
  const minutes = Number(str(formData, "duration") || "0");
  const deadline = opt(formData, "responseDeadline");
  return {
    type: str(formData, "type") as EventInput["type"],
    title,
    startsAt,
    endsAt: minutes > 0 ? new Date(startsAt.getTime() + minutes * 60_000) : null,
    location: opt(formData, "location"),
    description: opt(formData, "description"),
    responseDeadline: deadline ? parseLocalDateTime(deadline) : null,
  };
}

export async function newEvent(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}/ny`, async () => {
    const input = eventInput(formData);
    const until = opt(formData, "repeatUntil");
    if (until) await createEventSeries(db, ctx, teamId, input, parseLocalDateTime(`${until}T23:59`));
    else await createEvent(db, ctx, teamId, input);
  });
  redirect(`/hold/${teamId}`);
}

export async function editEvent(formData: FormData) {
  const { ctx } = await requireSession();
  const eventId = str(formData, "eventId");
  await attempt(`/aktivitet/${eventId}/ret`, () => updateEvent(db, ctx, eventId, eventInput(formData)));
  redirect(`/aktivitet/${eventId}`);
}

export async function cancelEvent(formData: FormData) {
  const { ctx } = await requireSession();
  const eventId = str(formData, "eventId");
  const cancelled = str(formData, "cancelled") === "1";
  const scope = str(formData, "scope") === "following" ? "following" : "one";
  await attempt(`/aktivitet/${eventId}`, () => setEventCancelled(db, ctx, eventId, cancelled, scope));
  revalidatePath(`/aktivitet/${eventId}`);
}

// --- Forening: kasserer ---

export async function addTreasurer(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/forening", () => grantTreasurerByEmail(db, ctx, str(formData, "clubId"), str(formData, "email")));
  revalidatePath("/forening");
}

export async function removeTreasurer(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/forening", () => revokeTreasurer(db, ctx, str(formData, "clubId"), str(formData, "profileId")));
  revalidatePath("/forening");
}

// --- Kasse ---

/** Tilbage til samme side i kassen, med foreningen valgt. */
const kasse = (f: FormData, path = "") => `/kasse${path}?klub=${encodeURIComponent(str(f, "clubId"))}`;

export async function newFee(formData: FormData) {
  const { ctx } = await requireSession();
  const back = kasse(formData, "/kontingenter");
  await attempt(back, () =>
    createFee(db, ctx, str(formData, "clubId"), {
      name: str(formData, "name"),
      amountOre: parseKr(str(formData, "amount")),
      interval: str(formData, "interval") as FeeInterval,
    }),
  );
  revalidatePath("/kasse/kontingenter");
}

export async function editFee(formData: FormData) {
  const { ctx } = await requireSession();
  const back = kasse(formData, "/kontingenter");
  await attempt(back, async () => {
    const feeId = str(formData, "feeId");
    if (formData.has("archive")) return setFeeArchived(db, ctx, feeId, str(formData, "archive") === "1");
    await updateFee(db, ctx, feeId, { name: str(formData, "name"), amountOre: parseKr(str(formData, "amount")) });
  });
  revalidatePath("/kasse/kontingenter");
}

export async function teamFee(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/kontingenter"), () => setTeamDefaultFee(db, ctx, str(formData, "teamId"), opt(formData, "feeId")));
  revalidatePath("/kasse/kontingenter");
}

export async function chargeFee(formData: FormData) {
  const { ctx } = await requireSession();
  let result = { created: 0, totalOre: 0 };
  await attempt(kasse(formData, "/kontingenter"), async () => {
    result = await runCharges(db, ctx, str(formData, "feeId"), str(formData, "period"), opt(formData, "dueDate") ?? undefined);
  });
  redirect(`${kasse(formData, "/opkraevninger")}&oprettet=${result.created}`);
}

export async function updateMember(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, () =>
    updateMembership(db, ctx, str(formData, "clubId"), str(formData, "profileId"), {
      feeId: formData.has("feeId") ? opt(formData, "feeId") : undefined,
      exempt: formData.has("exemptField") ? formData.has("exempt") : undefined,
      status: (opt(formData, "status") as "active" | "inactive" | null) ?? undefined,
    }),
  );
  revalidatePath("/kasse/medlemmer");
}

export async function singleCharge(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, async () => {
    const dueDate = str(formData, "dueDate");
    if (!dueDate) throw new Error("Vælg en betalingsfrist");
    await createSingleCharge(db, ctx, str(formData, "clubId"), str(formData, "profileId"), {
      description: str(formData, "description"),
      amountOre: parseKr(str(formData, "amount")),
      dueDate,
    });
  });
  revalidatePath("/kasse");
}

export async function chargeAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  const chargeId = str(formData, "chargeId");
  await attempt(back, async () => {
    switch (str(formData, "do")) {
      case "paid":
        return registerManualPayment(db, ctx, chargeId, opt(formData, "note"));
      case "cancel":
        return cancelCharge(db, ctx, chargeId);
      case "refund":
        return refundCharge(db, ctx, chargeId, getPaymentProvider());
    }
  });
  revalidatePath("/kasse");
}

export async function remind(formData: FormData) {
  const { ctx } = await requireSession();
  let r = { sent: 0, unreachable: [] as string[] };
  await attempt(kasse(formData), async () => {
    r = await sendReminders(db, ctx, str(formData, "clubId"), sendMail, await origin());
  });
  const missing = r.unreachable.length ? `&uden_mail=${encodeURIComponent(r.unreachable.join(", "))}` : "";
  redirect(`${kasse(formData)}&rykkere=${r.sent}${missing}`);
}

export async function connectStripe(formData: FormData) {
  const { ctx } = await requireSession();
  let url = "";
  await attempt(kasse(formData), async () => {
    url = await connectPayments(db, ctx, str(formData, "clubId"), getPaymentProvider(), await origin());
  });
  redirect(url);
}

// --- Betaling ---

export async function pay(formData: FormData) {
  const { ctx } = await requireSession();
  let url = "";
  await attempt("/betaling", async () => {
    url = await startCheckout(db, ctx, str(formData, "chargeId"), getPaymentProvider(), await origin());
  });
  redirect(url);
}

/** Kun testbetalingen: svarer til at Stripe bekræfter betalingen. */
export async function completeTestPayment(formData: FormData) {
  if (!mockPaymentsEnabled()) throw new Error("Testbetaling er slået fra");
  const { ctx } = await requireSession();
  const sessionId = str(formData, "session");
  await attempt(`/betal/test/${sessionId}`, async () => {
    await getCheckout(db, ctx, sessionId);
    await completeCheckout(db, sessionId);
  });
  redirect(`/betaling/kvittering?session=${encodeURIComponent(sessionId)}`);
}
