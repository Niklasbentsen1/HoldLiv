"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canActAs, ForbiddenError } from "../auth/permissions";
import { LoginError, requestLogin, sha256, verifyCode } from "../auth/login";
import { beginTotpSetup, completeMfa, confirmTotpSetup, disableTotp, MfaError, regenerateRecoveryCodes } from "../auth/mfa";
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
  respondToEventNotifying,
  rotateInviteCode,
  setEventCancelledNotifying,
  createPost,
  deleteMessage,
  deletePost,
  setPostPinned,
  postMessage,
  removePushSubscription,
  resetFeedToken,
  savePushSubscription,
  setNotificationPref,
  updateEventNotifying,
  updateMyPhone,
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
  saveModuleMatrix as saveModules,
  cancelFine,
  createFineType,
  giveFine,
  setFinePaid,
  setFineTypeArchived,
  updateFineType,
  assignTask,
  claimTask,
  createFruitList,
  createTask,
  deleteTask,
  distributeOpenTasks,
  releaseTask,
  setTaskDone,
  bookSeat,
  cancelOffer,
  cancelRideRequest,
  leaveSeat,
  offerRide,
  requestRide,
  updateOffer,
  updateModuleConfig,
  startCheckout,
  updateFee,
  updateMembership,
} from "../services";
import { parseKr, type FeeInterval } from "../lib/money";
import { getPaymentProvider, mockPaymentsEnabled } from "../lib/payments";
import { db } from "../lib/db";
import { sendLoginMail, sendMail } from "../lib/mail";
import { CHANNELS, KINDS } from "../lib/notify";
import { origin } from "../lib/origin";
import { getPushSender } from "../lib/push";
import { getSmsSender } from "../lib/sms";
import { SESSION_COOKIE, currentSessionToken, endSession, getSession, getUserId, requireSession, safeNext, setActingProfile, startSession } from "../lib/session";
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
    if (!(e instanceof ForbiddenError || e instanceof LoginError || e instanceof MfaError)) console.error(e);
    redirect(`${back}${back.includes("?") ? "&" : "?"}fejl=${encodeURIComponent(message)}`);
  }
}

async function deliverFromEnv() {
  return { mail: sendMail, sms: getSmsSender(), push: getPushSender(), baseUrl: await origin() };
}

// --- Login ---

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
  let pending = false;
  await attempt(`/login/kode?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`, async () => {
    pending = await startSession(await verifyCode(db, email, str(formData, "code")));
  });
  redirect(pending ? `/login/to-faktor?next=${encodeURIComponent(next)}` : next);
}

/** Andet trin af login for konti med to-faktor. */
export async function completeMfaAction(formData: FormData) {
  const next = safeNext(str(formData, "next"));
  const token = await currentSessionToken();
  if (!token) redirect("/login");
  await attempt(`/login/to-faktor?next=${encodeURIComponent(next)}`, () => completeMfa(db, token, str(formData, "code")));
  redirect(next);
}

export interface MfaState {
  error?: string;
  secret?: string;
  uri?: string;
  codes?: string[];
  done?: boolean;
}

async function mfaStep(fn: (userId: string) => Promise<MfaState>): Promise<MfaState> {
  const session = await getSession({ allowMfaSetup: true });
  if (!session) redirect("/login");
  try {
    return await fn(session.ctx.userId);
  } catch (e) {
    if (e instanceof MfaError) return { error: e.message };
    console.error(e);
    return { error: "Noget gik galt." };
  }
}

export const beginMfaAction = async (): Promise<MfaState> => mfaStep(async (u) => beginTotpSetup(db, u));
export const confirmMfaAction = async (_: MfaState, formData: FormData): Promise<MfaState> =>
  mfaStep(async (u) => ({ codes: await confirmTotpSetup(db, u, str(formData, "code")), done: true }));
export const disableMfaAction = async (_: MfaState, formData: FormData): Promise<MfaState> =>
  mfaStep(async (u) => {
    await disableTotp(db, u, str(formData, "code"));
    return { done: true };
  });
export const regenerateCodesAction = async (_: MfaState, formData: FormData): Promise<MfaState> =>
  mfaStep(async (u) => ({ codes: await regenerateRecoveryCodes(db, u, str(formData, "code")), done: true }));

/** Kun til demoen: log ind som en demoperson uden e-mail. */
export async function demoLogin(formData: FormData) {
  if (process.env.NODE_ENV === "production" && process.env.DEMO_LOGIN !== "1") throw new Error("Demo-login er slået fra");
  await startSession(str(formData, "userId"), { skipMfa: true });
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
  await attempt(back, async () =>
    respondToEventNotifying(
      db,
      ctx,
      await deliverFromEnv(),
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

// --- Moduler ---

/** Foreningens oversigt: afkrydsningerne er den ønskede tilstand for hvert tilgængeligt modul. */
export async function saveModuleMatrix(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/forening", async () => {
    const desired = Object.fromEntries(
      formData.getAll("module").map(String).map((key) => [key, formData.getAll(`on_${key}`).map(String)]),
    );
    await saveModules(db, ctx, str(formData, "clubId"), formData.getAll("team").map(String), desired);
  });
  revalidatePath("/forening");
  redirect("/forening");
}

export async function saveModuleConfig(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  const key = str(formData, "module");
  await attempt(`/hold/${teamId}/moduler`, () => updateModuleConfig(db, ctx, teamId, key, Object.fromEntries(formData)));
  revalidatePath(`/hold/${teamId}`);
  redirect(`/hold/${teamId}/moduler`);
}

// --- Samkørsel ---

function offerInput(formData: FormData) {
  const departs = str(formData, "departsAt");
  return {
    seats: Number(str(formData, "seats")),
    meetingPoint: str(formData, "meetingPoint"),
    departsAt: departs ? parseLocalDateTime(departs) : null,
    note: opt(formData, "note"),
  };
}

/** Kører en samkørselshandling og sender tilbage til holdets samkørselsside. */
async function carpool(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  const back = `/hold/${teamId}/samkorsel`;
  await attempt(`${back}#e${str(formData, "eventId")}`, () => fn(ctx));
  revalidatePath(back);
  redirect(`${back}#e${str(formData, "eventId")}`);
}

export const offerRideAction = async (f: FormData) => carpool(f, (ctx) => offerRide(db, ctx, str(f, "eventId"), offerInput(f)));
export const updateOfferAction = async (f: FormData) => carpool(f, (ctx) => updateOffer(db, ctx, str(f, "offerId"), offerInput(f)));
export const cancelOfferAction = async (f: FormData) => carpool(f, (ctx) => cancelOffer(db, ctx, str(f, "offerId")));
export const bookSeatAction = async (f: FormData) => carpool(f, (ctx) => bookSeat(db, ctx, str(f, "offerId"), str(f, "profileId")));
export const leaveSeatAction = async (f: FormData) => carpool(f, (ctx) => leaveSeat(db, ctx, str(f, "offerId"), str(f, "profileId")));
export const requestRideAction = async (f: FormData) =>
  carpool(f, (ctx) => requestRide(db, ctx, str(f, "eventId"), str(f, "profileId"), opt(f, "note")));
export const cancelRideRequestAction = async (f: FormData) =>
  carpool(f, (ctx) => cancelRideRequest(db, ctx, str(f, "eventId"), str(f, "profileId")));

// --- Frugt og opgaver ---

async function tasksAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/hold/${str(formData, "teamId")}/opgaver`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

export const createTaskAction = async (f: FormData) =>
  tasksAction(f, (ctx) =>
    createTask(db, ctx, str(f, "teamId"), {
      kind: str(f, "kind") === "fruit" ? "fruit" : "task",
      title: str(f, "title"),
      note: opt(f, "note"),
      eventId: opt(f, "eventId"),
    }),
  );
export const createFruitListAction = async (f: FormData) =>
  tasksAction(f, (ctx) => createFruitList(db, ctx, str(f, "teamId"), f.getAll("eventId").map(String)));
export const distributeTasksAction = async (f: FormData) => tasksAction(f, (ctx) => distributeOpenTasks(db, ctx, str(f, "teamId")));
export const claimTaskAction = async (f: FormData) => tasksAction(f, (ctx) => claimTask(db, ctx, str(f, "taskId"), str(f, "profileId")));
export const releaseTaskAction = async (f: FormData) => tasksAction(f, (ctx) => releaseTask(db, ctx, str(f, "taskId")));
export const doneTaskAction = async (f: FormData) => tasksAction(f, (ctx) => setTaskDone(db, ctx, str(f, "taskId"), str(f, "done") === "1"));
export const assignTaskAction = async (f: FormData) => tasksAction(f, (ctx) => assignTask(db, ctx, str(f, "taskId"), opt(f, "profileId")));
export const deleteTaskAction = async (f: FormData) => tasksAction(f, (ctx) => deleteTask(db, ctx, str(f, "taskId")));

// --- Bødekasse ---

async function finesAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/hold/${str(formData, "teamId")}/bodekasse`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

export const createFineTypeAction = async (f: FormData) =>
  finesAction(f, (ctx) => createFineType(db, ctx, str(f, "teamId"), { name: str(f, "name"), amountOre: parseKr(str(f, "amount")) }));
export const updateFineTypeAction = async (f: FormData) =>
  finesAction(f, (ctx) => updateFineType(db, ctx, str(f, "fineTypeId"), { name: str(f, "name"), amountOre: parseKr(str(f, "amount")) }));
export const archiveFineTypeAction = async (f: FormData) =>
  finesAction(f, (ctx) => setFineTypeArchived(db, ctx, str(f, "fineTypeId"), str(f, "archived") === "1"));
export const giveFineAction = async (f: FormData) =>
  finesAction(f, (ctx) => {
    const typeId = str(f, "fineTypeId");
    return giveFine(db, ctx, str(f, "teamId"), {
      profileId: str(f, "profileId"),
      fineTypeId: typeId || null,
      description: opt(f, "description"),
      amountOre: typeId ? null : parseKr(str(f, "amount")),
    });
  });
export const payFineAction = async (f: FormData) => finesAction(f, (ctx) => setFinePaid(db, ctx, str(f, "fineId"), str(f, "paid") === "1"));
export const cancelFineAction = async (f: FormData) => finesAction(f, (ctx) => cancelFine(db, ctx, str(f, "fineId")));

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
    maxParticipants: opt(formData, "maxParticipants") ? Number(opt(formData, "maxParticipants")) : null,
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
  await attempt(`/aktivitet/${eventId}/ret`, async () => updateEventNotifying(db, ctx, await deliverFromEnv(), eventId, eventInput(formData)));
  redirect(`/aktivitet/${eventId}`);
}

export async function cancelEvent(formData: FormData) {
  const { ctx } = await requireSession();
  const eventId = str(formData, "eventId");
  const cancelled = str(formData, "cancelled") === "1";
  const scope = str(formData, "scope") === "following" ? "following" : "one";
  await attempt(`/aktivitet/${eventId}`, async () => setEventCancelledNotifying(db, ctx, await deliverFromEnv(), eventId, cancelled, scope));
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
    await updateFee(db, ctx, feeId, {
      name: str(formData, "name"),
      amountOre: parseKr(str(formData, "amount")),
      interval: str(formData, "interval") as FeeInterval,
    });
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

// --- Indstillinger: beskeder ---

export async function saveNotificationPrefs(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/indstillinger", async () => {
    await updateMyPhone(db, ctx, str(formData, "phone"));
    for (const kind of Object.keys(KINDS)) {
      for (const channel of CHANNELS) {
        await setNotificationPref(db, ctx, kind, channel, formData.get(`${kind}:${channel}`) === "on");
      }
    }
  });
  redirect("/indstillinger?gemt=1");
}

export async function subscribePush(sub: { endpoint: string; p256dh: string; auth: string }) {
  const { ctx } = await requireSession();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new Error("Du er ikke logget ind.");
  await savePushSubscription(db, ctx, sha256(token), sub);
  revalidatePath("/indstillinger");
}

export async function unsubscribePush(endpoint: string) {
  const { ctx } = await requireSession();
  await removePushSubscription(db, ctx, endpoint);
  revalidatePath("/indstillinger");
}

export async function resetCalendarLink() {
  const { ctx } = await requireSession();
  await resetFeedToken(db, ctx);
  revalidatePath("/indstillinger");
}

// --- Holdchat ---

export async function postChatMessageAction(formData: FormData) {
  const { ctx } = await requireSession();
  const threadId = str(formData, "threadId");
  const back = `/hold/${str(formData, "teamId")}/chat?samtale=${threadId}`;
  await attempt(back, async () => postMessage(db, ctx, await deliverFromEnv(), threadId, String(formData.get("body") ?? "")));
  redirect(back);
}

export async function deleteChatMessageAction(formData: FormData) {
  const { ctx } = await requireSession();
  const threadId = str(formData, "threadId");
  const back = `/hold/${str(formData, "teamId")}/chat?samtale=${threadId}`;
  await attempt(back, () => deleteMessage(db, ctx, str(formData, "messageId")));
  redirect(back);
}

// --- Nyheder og opslagstavle ---

export async function createPostAction(formData: FormData) {
  const { ctx } = await requireSession();
  const kind = str(formData, "kind") === "board" ? "board" : "news";
  const back = `/nyheder${kind === "board" ? "?type=opslag" : ""}`;
  await attempt(back, async () =>
    createPost(db, ctx, await deliverFromEnv(), {
      kind,
      scope: str(formData, "scope"),
      title: str(formData, "title"),
      body: String(formData.get("body") ?? ""),
      pinned: formData.get("pinned") === "on",
      expiresInDays: kind === "board" && str(formData, "days") ? Number(str(formData, "days")) : null,
    }),
  );
  redirect(back);
}

export async function pinPostAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, () => setPostPinned(db, ctx, str(formData, "postId"), str(formData, "pinned") === "1"));
  redirect(back);
}

export async function deletePostAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, () => deletePost(db, ctx, str(formData, "postId")));
  redirect(back);
}
