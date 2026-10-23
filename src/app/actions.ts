"use server";

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { canActAs, ForbiddenError } from "../auth/permissions";
import { decodeCsvBytes } from "../lib/csv";
import { acceptMergeOffer, declineMergeOffer } from "../auth/merge";
import { LoginError, requestLogin, sha256, verifyCode } from "../auth/login";
import { beginTotpSetup, completeMfa, confirmTotpSetup, disableTotp, MfaError, regenerateRecoveryCodes } from "../auth/mfa";
import {
  addCoachByEmail,
  addMatchEvent,
  clearResult,
  recordResult,
  removeMatchEvent,
  saveLineup,
  saveReport,
  setLineupPublished,
  unpublishReport,
  type LineupEntry,
  type MatchEventKind,
  addGuardianByEmail,
  createChildProfile,
  createEvent,
  createEventSeries,
  createProfileForUser,
  deleteChildProfile,
  deleteMyAccount,
  recordPrivacyConsent,
  setConsent,
  type ConsentKind,
  createTeam,
  joinTeamByInvite,
  adviseClub,
  askMemberService,
  setAiService,
  runImport,
  registerClub,
  submitSignup,
  saveSignupSettings,
  decideSignup,
  TARGETS,
  MAX_IMPORT_BYTES,
  type ColumnMap,
  type ImportReport,
  leaveWaitlist,
  promoteFromWaitlist,
  removePlayerNotifying,
  setTeamCapacity,
  respondToEventNotifying,
  rotateInviteCode,
  setEventCancelledNotifying,
  createPost,
  deleteMessage,
  deletePost,
  setPostPinned,
  saveSiteSettings,
  admitTicket,
  cancelTicketEvent,
  completeTicketOrder,
  createTicketEvent,
  createTicketOrder,
  refundTicketOrder,
  sendTicketMail,
  updateTicketEvent,
  setPostPublic,
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
  saveCardFromCheckout,
  removeSavedCard,
  submitExpense,
  createCamp,
  updateCamp,
  cancelCamp,
  signUpForCamp,
  cancelCampSignup,
  createResource,
  updateResource,
  archiveResource,
  createBooking,
  approveBooking,
  rejectBooking,
  cancelBooking,
  createShift,
  updateShift,
  cancelShift,
  signUpForShift,
  cancelShiftSignup,
  createContract,
  updateContract,
  deleteDraftContract,
  sendContract,
  signContract,
  declineContract,
  cancelContract,
  requireCertificate,
  giveCertificateConsent,
  recordWrittenConsent,
  markCertificateRequested,
  registerCertificateResult,
  removeCertificate,
  cancelExpense,
  decideExpense,
  markExpensePaid,
  setMileageRate,
  setAutoCharge,
  connectPayments,
  createFee,
  setArrearsBlock,
  setCardOverdueRule,
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
  addFundEntry,
  resetCard,
  createScreen,
  deleteScreen,
  resetScreenToken,
  updateScreen,
  deleteDocument,
  replaceDocumentFile,
  updateDocumentInfo,
  uploadDocument,
  closePoll,
  createPoll,
  deletePoll,
  vote,
  withdrawVote,
  cancelFine,
  cancelFundEntry,
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
import { getAdvisor } from "../lib/advisor";
import { getAssistant } from "../lib/memberAssistant";
import { getDevicePushSender } from "../lib/devicePush";
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
    // Databasefejl (med årsag eller "Failed query") vises aldrig for brugeren.
    const technical = e instanceof Error && (("cause" in e && !!e.cause) || e.message.startsWith("Failed query"));
    const message =
      e instanceof ForbiddenError ? "Det har du ikke adgang til." : e instanceof Error && !technical ? e.message : "Noget gik galt.";
    if (!(e instanceof ForbiddenError || e instanceof LoginError || e instanceof MfaError)) console.error(e);
    redirect(`${back}${back.includes("?") ? "&" : "?"}fejl=${encodeURIComponent(message)}`);
  }
}

function paymentProviderOrUndefined() {
  try {
    return getPaymentProvider();
  } catch {
    return undefined;
  }
}

async function deliverFromEnv() {
  return { mail: sendMail, sms: getSmsSender(), push: getPushSender(), devicePush: getDevicePushSender(), baseUrl: await origin() };
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
  mfaStep(async (u) => ({ codes: await confirmTotpSetup(db, u, str(formData, "code"), new Date(), await currentSessionToken()), done: true }));
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

// --- Holdforslag ---

export async function adviceAction(_: { text?: string; error?: string }, formData: FormData): Promise<{ text?: string; error?: string }> {
  const { ctx } = await requireSession();
  const advisor = getAdvisor();
  if (!advisor) return { error: "AI-rådgiveren er ikke sat op endnu." };
  try {
    return { text: await adviseClub(db, ctx, str(formData, "clubId"), advisor) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Det har du ikke adgang til." };
    console.error(e);
    return { error: "Rådgiveren kunne ikke svare lige nu. Prøv igen om lidt." };
  }
}

// --- AI-medlemsservice ---

export async function aiServiceSettingAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/forening", () => setAiService(db, ctx, str(formData, "clubId"), formData.get("enabled") === "1"));
  revalidatePath("/forening");
  redirect("/forening");
}

export async function memberServiceAction(_: { text?: string; error?: string }, formData: FormData): Promise<{ text?: string; error?: string }> {
  const { ctx } = await requireSession();
  const assistant = getAssistant();
  if (!assistant) return { error: "AI-hjælpen er ikke sat op endnu." };
  try {
    return { text: await askMemberService(db, ctx, str(formData, "question"), assistant) };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Det har du ikke adgang til." };
    if (e instanceof Error && !("cause" in e && e.cause) && !e.message.startsWith("Failed query")) return { error: e.message };
    console.error(e);
    return { error: "Hjælpen kunne ikke svare lige nu. Prøv igen om lidt." };
  }
}

// --- Medlemsimport ---

export interface ImportState {
  error?: string;
  text?: string;
  headers?: string[];
  mapping?: ColumnMap[];
  counts?: ImportReport["counts"];
  newTeams?: string[];
  sample?: { line: number; name: string; status: string; notes: string[] }[];
  done?: { created: number; updated: number; teamsCreated: number };
}

const STATUS_LABEL = { new: "Ny", existing: "Findes", duplicate: "Dublet", error: "Fejl" } as const;

export async function importAction(_: ImportState, formData: FormData): Promise<ImportState> {
  const { ctx } = await requireSession();
  const clubId = str(formData, "clubId");
  const file = formData.get("file");
  const text = typeof file === "object" && file && "arrayBuffer" in file && file.size > 0 ? (file.size > MAX_IMPORT_BYTES ? null : decodeCsvBytes(new Uint8Array(await file.arrayBuffer()))) : String(formData.get("text") ?? "");
  if (text === null) return { error: "Filen er for stor. Del den op i flere filer." };
  if (!text.trim()) return { error: "Vælg en fil, eller indsæt medlemmerne i feltet." };
  let mapping: ColumnMap[] | null = null;
  if (formData.get("headerCount")) {
    const targets = new Set<string>([...Object.keys(TARGETS), "custom", "ignore"]);
    const names = JSON.parse(String(formData.get("headers") ?? "[]")) as string[];
    mapping = names.map((h, i) => {
      const v = str(formData, `map-${i}`);
      return { target: (targets.has(v) ? v : "ignore") as ColumnMap["target"], name: h };
    });
  }
  try {
    const report = await runImport(db, ctx, clubId, text, mapping, formData.get("intent") === "commit");
    if (report.commit) revalidatePath("/kasse/medlemmer");
    return {
      text,
      headers: report.headers,
      mapping: report.mapping,
      counts: report.counts,
      newTeams: report.newTeams,
      // Rækker med fejl og advarsler først, så de første "nye" rækker, så tegnfejl (æøå) kan ses.
      sample: [...report.rows.filter((r) => r.status !== "new" || r.warnings.length), ...report.rows.filter((r) => r.status === "new" && !r.warnings.length).slice(0, 5)].slice(0, 40).map((r) => ({
        line: r.line,
        name: `${r.person.firstName} ${r.person.lastName}`.trim() || "(uden navn)",
        status: STATUS_LABEL[r.status],
        notes: [...r.errors, ...r.warnings, ...(r.status === "new" && !r.errors.length ? [[r.birthDate, r.person.email, r.teams.join(", ")].filter(Boolean).join(" · ")].filter(Boolean) : [])],
      })),
      done: report.commit,
    };
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "Det har du ikke adgang til." };
    const technical = e instanceof Error && (("cause" in e && !!e.cause) || e.message.startsWith("Failed query"));
    if (technical || !(e instanceof Error)) console.error(e);
    return { error: e instanceof Error && !technical ? e.message : "Noget gik galt.", text };
  }
}

// --- Online indmeldelse ---

export interface SignupState {
  error?: string;
  done?: boolean;
  values?: Record<string, string>;
}

/** Den åbne tilmeldingsside. Ingen login; honeypot-feltet "website" skal være tomt. */
export async function submitSignupAction(slug: string, _: SignupState, formData: FormData): Promise<SignupState> {
  const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
  if (str(formData, "website")) return { done: true };
  try {
    await submitSignup(
      db,
      slug,
      {
        firstName: str(formData, "firstName"),
        lastName: str(formData, "lastName"),
        birthDate: str(formData, "birthDate"),
        email: str(formData, "email"),
        phone: opt(formData, "phone"),
        guardianName: opt(formData, "guardianName"),
        teamId: opt(formData, "teamId"),
        message: opt(formData, "message"),
        acceptTerms: formData.get("acceptTerms") === "on",
      },
      sendMail,
      await origin(),
      new Date(),
      ((await headers()).get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
    );
    return { done: true };
  } catch (e) {
    const technical = e instanceof Error && (("cause" in e && !!e.cause) || e.message.startsWith("Failed query"));
    if (technical || !(e instanceof Error)) console.error(e);
    return { error: e instanceof Error && !technical ? e.message : "Noget gik galt. Prøv igen om lidt.", values };
  }
}

export async function saveSignupSettingsAction(formData: FormData) {
  const { ctx } = await requireSession();
  const clubId = str(formData, "clubId");
  const age = (k: string) => (str(formData, k) === "" ? null : Number(str(formData, k)));
  await attempt(`/forening/tilmeldinger?klub=${clubId}`, () =>
    saveSignupSettings(db, ctx, clubId, { enabled: formData.get("enabled") === "on", minAge: age("minAge"), maxAge: age("maxAge"), terms: opt(formData, "terms") }),
  );
  revalidatePath("/forening/tilmeldinger");
  redirect(`/forening/tilmeldinger?klub=${clubId}`);
}

export async function decideSignupAction(formData: FormData) {
  const { ctx } = await requireSession();
  const clubId = str(formData, "clubId");
  const approve = formData.get("intent") === "approve";
  await attempt(`/forening/tilmeldinger?klub=${clubId}`, () =>
    decideSignup(db, ctx, str(formData, "requestId"), approve ? { approve: true, teamId: opt(formData, "teamId") } : { approve: false, note: opt(formData, "note") }, sendMail),
  );
  revalidatePath("/forening/tilmeldinger");
  redirect(`/forening/tilmeldinger?klub=${clubId}`);
}

// --- Samling af profiler ---

export async function mergeOfferAction(formData: FormData) {
  const { ctx } = await requireSession();
  const profileId = str(formData, "profileId");
  await attempt("/familie", () => (formData.get("intent") === "yes" ? acceptMergeOffer(db, ctx.userId, profileId) : declineMergeOffer(db, ctx.userId, profileId)));
  revalidatePath("/familie");
  redirect("/familie");
}

// --- Privatliv (GDPR) ---

export async function saveConsent(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/indstillinger/privatliv", async () => {
    await setConsent(db, ctx, str(formData, "profileId"), str(formData, "kind") as ConsentKind, formData.get("granted") === "1");
  });
  redirect("/indstillinger/privatliv?gemt=1");
}

export async function deleteAccountAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/indstillinger/privatliv", () => deleteMyAccount(db, ctx, str(formData, "email"), paymentProviderOrUndefined()));
  await endSession();
  redirect("/login?fejl=" + encodeURIComponent("Din konto og dine oplysninger er slettet."));
}

export async function deleteChildAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/indstillinger/privatliv", async () => {
    if (formData.get("sure") !== "on") throw new Error("Sæt kryds for at bekræfte sletningen.");
    await deleteChildProfile(db, ctx, str(formData, "profileId"));
  });
  redirect("/indstillinger/privatliv?gemt=1");
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
    if (formData.get("privacy") !== "on") throw new Error("Du skal acceptere privatlivspolitikken for at bruge HoldLiv.");
    const profile = await createProfileForUser(db, userId, { firstName, lastName, phone: opt(formData, "phone"), birthDate: opt(formData, "birthDate") });
    await recordPrivacyConsent(db, userId, profile.id);
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
  let waiting = false;
  await attempt(`/join/${code}`, async () => {
    if (ids.length === 0) throw new Error("Vælg hvem der skal på holdet");
    for (const id of ids) {
      const r = await joinTeamByInvite(db, ctx, code, id);
      if (r.waitlisted) waiting = true;
      else teamId = r.id;
    }
  });
  // Står alle på venteliste, kan man endnu ikke se holdet; så vises ventelisten under Familie.
  redirect(teamId ? `/hold/${teamId}${waiting ? "?venteliste=1" : ""}` : "/familie?venteliste=1");
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
  await attempt(`/hold/${teamId}`, async () => removePlayerNotifying(db, ctx, await deliverFromEnv(), teamId, str(formData, "profileId")));
  revalidatePath(`/hold/${teamId}`);
}

export async function saveCapacity(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}`, async () => {
    const raw = str(formData, "capacity");
    await setTeamCapacity(db, ctx, teamId, raw === "" ? null : Number(raw), formData.get("autoPromote") === "on", await deliverFromEnv());
  });
  revalidatePath(`/hold/${teamId}`);
}

export async function promotePlayer(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  await attempt(`/hold/${teamId}`, async () =>
    promoteFromWaitlist(db, ctx, teamId, str(formData, "profileId"), { allowOverfull: formData.get("overfull") === "on", deliver: await deliverFromEnv() }),
  );
  revalidatePath(`/hold/${teamId}`);
}

export async function leaveWaitlistAction(formData: FormData) {
  const { ctx } = await requireSession();
  const teamId = str(formData, "teamId");
  const back = safeNext(str(formData, "back")) || `/hold/${teamId}`;
  await attempt(back, () => leaveWaitlist(db, ctx, teamId, str(formData, "profileId")));
  revalidatePath(back);
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

// --- Holdkasse ---

async function teamFundAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/hold/${str(formData, "teamId")}/holdkasse`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

export const addFundEntryAction = async (f: FormData) =>
  teamFundAction(f, (ctx) =>
    addFundEntry(db, ctx, str(f, "teamId"), {
      kind: str(f, "kind") === "withdrawal" ? "withdrawal" : "deposit",
      amountOre: parseKr(str(f, "amount")),
      description: str(f, "description"),
      profileId: opt(f, "profileId"),
      entryDate: opt(f, "entryDate"),
    }),
  );
export const cancelFundEntryAction = async (f: FormData) => teamFundAction(f, (ctx) => cancelFundEntry(db, ctx, str(f, "entryId")));

// --- Afstemninger ---

async function pollAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/hold/${str(formData, "teamId")}/afstemninger`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

export const createPollAction = async (f: FormData) =>
  pollAction(f, async (ctx) =>
    createPoll(
      db,
      ctx,
      str(f, "teamId"),
      {
        question: str(f, "question"),
        description: opt(f, "description"),
        options: str(f, "options").split("\n"),
        multiple: f.get("multiple") === "1",
        anonymous: f.get("anonymous") === "1",
        closesAt: opt(f, "closesAt") ? parseLocalDateTime(str(f, "closesAt")) : null,
      },
      await deliverFromEnv(),
    ),
  );
export const votePollAction = async (f: FormData) =>
  pollAction(f, (ctx) => vote(db, ctx, str(f, "pollId"), f.getAll("optionId").map(String), str(f, "profileId")));
export const withdrawVoteAction = async (f: FormData) => pollAction(f, (ctx) => withdrawVote(db, ctx, str(f, "pollId"), str(f, "profileId")));
export const closePollAction = async (f: FormData) => pollAction(f, (ctx) => closePoll(db, ctx, str(f, "pollId")));
export const deletePollAction = async (f: FormData) => pollAction(f, (ctx) => deletePoll(db, ctx, str(f, "pollId")));

// --- Dokumentarkiv ---

async function fileOf(f: FormData, name: string) {
  const file = f.get(name);
  return file instanceof File && file.size > 0 ? { fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

async function archiveAction(fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  await attempt("/arkiv", () => fn(ctx));
  revalidatePath("/arkiv");
  redirect("/arkiv");
}

export const uploadDocumentAction = async (f: FormData) =>
  archiveAction(async (ctx) => {
    const file = await fileOf(f, "file");
    if (!file) throw new Error("Vælg en fil.");
    // Målgruppen står som "club:<id>", "board:<id>" eller "team:<klub>:<hold>".
    const [audience, a, b] = str(f, "target").split(":");
    if (audience !== "club" && audience !== "board" && audience !== "team") throw new Error("Vælg, hvem dokumentet er til.");
    return uploadDocument(db, ctx, a, {
      audience,
      teamId: audience === "team" ? b : null,
      title: str(f, "title"),
      description: opt(f, "description"),
      category: opt(f, "category"),
      ...file,
    });
  });
export const replaceDocumentAction = async (f: FormData) =>
  archiveAction(async (ctx) => {
    const file = await fileOf(f, "file");
    if (!file) throw new Error("Vælg en fil.");
    return replaceDocumentFile(db, ctx, str(f, "documentId"), file);
  });
export const updateDocumentAction = async (f: FormData) =>
  archiveAction((ctx) => updateDocumentInfo(db, ctx, str(f, "documentId"), { title: str(f, "title"), description: opt(f, "description"), category: opt(f, "category") }));
export const deleteDocumentAction = async (f: FormData) => archiveAction((ctx) => deleteDocument(db, ctx, str(f, "documentId")));

// --- Infoskærm ---

async function screenAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/forening/skaerme?klub=${str(formData, "clubId")}`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

const screenInput = (f: FormData) => ({
  name: str(f, "name"),
  message: opt(f, "message"),
  showNews: f.get("showNews") === "1",
  daysAhead: Number(str(f, "daysAhead") || 3),
});
export const createScreenAction = async (f: FormData) => screenAction(f, (ctx) => createScreen(db, ctx, str(f, "clubId"), screenInput(f)));
export const updateScreenAction = async (f: FormData) => screenAction(f, (ctx) => updateScreen(db, ctx, str(f, "screenId"), screenInput(f)));
export const resetScreenTokenAction = async (f: FormData) => screenAction(f, (ctx) => resetScreenToken(db, ctx, str(f, "screenId")));
export const deleteScreenAction = async (f: FormData) => screenAction(f, (ctx) => deleteScreen(db, ctx, str(f, "screenId")));

// --- Hjemmeside ---

export async function saveSiteSettingsAction(formData: FormData) {
  const { ctx } = await requireSession();
  const clubId = str(formData, "clubId");
  const back = `/forening/hjemmeside?klub=${clubId}`;
  await attempt(back, () =>
    saveSiteSettings(db, ctx, clubId, {
      enabled: formData.get("enabled") === "on",
      intro: opt(formData, "intro"),
      contact: opt(formData, "contact"),
      showTeams: formData.get("showTeams") === "on",
      showCalendar: formData.get("showCalendar") === "on",
    }),
  );
  revalidatePath(back);
  redirect(back);
}

// --- Medlemskort ---

export async function resetCardAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/medlemskort", () => resetCard(db, ctx, str(formData, "clubId"), str(formData, "profileId")));
  revalidatePath("/medlemskort");
  redirect("/medlemskort");
}

// --- Kampe: opstilling, resultat, referat ---

async function matchAction(formData: FormData, fn: (ctx: Awaited<ReturnType<typeof requireSession>>["ctx"]) => Promise<unknown>) {
  const { ctx } = await requireSession();
  const back = `/hold/${str(formData, "teamId")}/kampe/${str(formData, "eventId")}`;
  await attempt(back, () => fn(ctx));
  revalidatePath(back);
  redirect(back);
}

export const saveLineupAction = async (f: FormData) =>
  matchAction(f, (ctx) => {
    const entries: LineupEntry[] = [];
    for (const profileId of f.getAll("profileId").map(String)) {
      const slot = str(f, `slot_${profileId}`);
      if (slot === "start" || slot === "bench") entries.push({ profileId, slot, position: opt(f, `pos_${profileId}`) });
    }
    // Spillerne på banen står først, så rækkefølgen på siden følger opstillingen.
    entries.sort((a, b) => Number(b.slot === "start") - Number(a.slot === "start"));
    return saveLineup(db, ctx, str(f, "eventId"), { entries, opponent: str(f, "opponent"), formation: str(f, "formation") });
  });
export const publishLineupAction = async (f: FormData) =>
  matchAction(f, async (ctx) => setLineupPublished(db, ctx, str(f, "eventId"), str(f, "published") === "1", await deliverFromEnv()));
export const recordResultAction = async (f: FormData) =>
  matchAction(f, (ctx) => {
    const minutes: Record<string, number | null> = {};
    for (const profileId of f.getAll("profileId").map(String)) {
      const m = str(f, `min_${profileId}`);
      minutes[profileId] = m === "" ? null : Number(m);
    }
    return recordResult(db, ctx, str(f, "eventId"), { goalsFor: str(f, "goalsFor") === "" ? NaN : Number(str(f, "goalsFor")), goalsAgainst: str(f, "goalsAgainst") === "" ? NaN : Number(str(f, "goalsAgainst")), minutes });
  });
export const clearResultAction = async (f: FormData) => matchAction(f, (ctx) => clearResult(db, ctx, str(f, "eventId")));
export const addMatchEventAction = async (f: FormData) =>
  matchAction(f, (ctx) =>
    addMatchEvent(db, ctx, str(f, "eventId"), {
      kind: str(f, "kind") as MatchEventKind,
      profileId: opt(f, "playerId"),
      assistProfileId: opt(f, "assistId"),
      minute: opt(f, "minute") === null ? null : Number(str(f, "minute")),
    }),
  );
export const removeMatchEventAction = async (f: FormData) => matchAction(f, (ctx) => removeMatchEvent(db, ctx, str(f, "matchEventId")));
export const saveReportAction = async (f: FormData) =>
  matchAction(f, (ctx) => saveReport(db, ctx, str(f, "eventId"), { text: String(f.get("report") ?? ""), publish: str(f, "publish") === "1" }));
export const unpublishReportAction = async (f: FormData) => matchAction(f, (ctx) => unpublishReport(db, ctx, str(f, "eventId")));

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
      ...feeExtras(formData),
    }),
  );
  revalidatePath("/kasse/kontingenter");
}

/** Foreningens egne regler: indmeldelsesgebyr, forholdsmæssig første periode og søskenderabat. */
function feeExtras(formData: FormData) {
  return {
    joinFeeOre: str(formData, "joinFee") ? parseKr(str(formData, "joinFee")) : 0,
    prorate: formData.has("prorate"),
    siblingDiscountPercent: str(formData, "siblingDiscount") ? Number(str(formData, "siblingDiscount")) : 0,
  };
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
      ...feeExtras(formData),
    });
  });
  revalidatePath("/kasse/kontingenter");
}

export async function saveArrearsBlock(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/kontingenter"), () => setArrearsBlock(db, ctx, str(formData, "clubId"), str(formData, "days") === "" ? null : Number(str(formData, "days"))));
  revalidatePath("/kasse/kontingenter");
}

export async function saveCardOverdueRule(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/kontingenter"), () => setCardOverdueRule(db, ctx, str(formData, "clubId"), formData.get("invalid") === "on"));
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
    result = await runCharges(db, ctx, str(formData, "feeId"), str(formData, "period"), opt(formData, "dueDate") ?? undefined, { includeJoinFee: formData.get("joinFee") === "on" });
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
      discountPercent: formData.has("discountPercent") ? Number(str(formData, "discountPercent") || 0) : undefined,
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
    url = await startCheckout(db, ctx, str(formData, "chargeId"), getPaymentProvider(), await origin(), { saveCard: formData.get("saveCard") === "on" });
  });
  redirect(url);
}

export async function removeCardAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/betaling", () => removeSavedCard(db, ctx, str(formData, "cardId"), getPaymentProvider()));
  redirect("/betaling");
}

export async function saveAutoCharge(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/kontingenter"), () => setAutoCharge(db, ctx, str(formData, "clubId"), formData.get("enabled") === "on"));
}

/** Kun testbetalingen: svarer til at Stripe bekræfter betalingen. */
export async function completeTestPayment(formData: FormData) {
  if (!mockPaymentsEnabled()) throw new Error("Testbetaling er slået fra");
  const { ctx } = await requireSession();
  const sessionId = str(formData, "session");
  await attempt(`/betal/test/${sessionId}`, async () => {
    await getCheckout(db, ctx, sessionId);
    await completeCheckout(db, sessionId);
    await saveCardFromCheckout(db, getPaymentProvider(), sessionId);
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
      publicOnSite: formData.get("publicOnSite") === "on",
      expiresInDays: kind === "board" && str(formData, "days") ? Number(str(formData, "days")) : null,
    }),
  );
  redirect(back);
}

export async function publicPostAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = safeNext(str(formData, "back"));
  await attempt(back, () => setPostPublic(db, ctx, str(formData, "postId"), str(formData, "public") === "1"));
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

// --- Udlæg og kørsel ---

export async function submitExpenseAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/udlaeg", async () => {
    const file = formData.get("receipt");
    const receipt = file instanceof File && file.size > 0 ? { bytes: new Uint8Array(await file.arrayBuffer()) } : null;
    const kind = str(formData, "kind") === "mileage" ? "mileage" : "expense";
    await submitExpense(
      db,
      ctx,
      str(formData, "clubId"),
      {
        kind,
        description: str(formData, "description"),
        spentOn: str(formData, "spentOn"),
        teamId: opt(formData, "teamId"),
        amountOre: kind === "expense" ? parseKr(str(formData, "amount")) : undefined,
        km: kind === "mileage" ? Number(str(formData, "km").replace(",", ".")) : undefined,
        receipt,
      },
      await deliverFromEnv(),
    );
  });
  redirect("/udlaeg?sendt=1");
}

export async function cancelExpenseAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/udlaeg", () => cancelExpense(db, ctx, str(formData, "claimId")));
  revalidatePath("/udlaeg");
}

export async function decideExpenseAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = kasse(formData, "/udlaeg");
  await attempt(back, async () =>
    decideExpense(db, ctx, str(formData, "claimId"), str(formData, "decision") === "approve" ? "approve" : "reject", opt(formData, "reason"), await deliverFromEnv()),
  );
  revalidatePath("/kasse/udlaeg");
}

export async function payExpenseAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/udlaeg"), async () => markExpensePaid(db, ctx, str(formData, "claimId"), opt(formData, "note"), await deliverFromEnv()));
  revalidatePath("/kasse/udlaeg");
}

export async function saveMileageRate(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/udlaeg"), () => setMileageRate(db, ctx, str(formData, "clubId"), str(formData, "rate") === "" ? null : parseKr(str(formData, "rate"))));
  revalidatePath("/kasse/udlaeg");
}

// --- Camps ---

const campInput = (f: FormData) => ({
  name: str(f, "name"),
  description: opt(f, "description"),
  startsOn: str(f, "startsOn"),
  endsOn: str(f, "endsOn") || str(f, "startsOn"),
  priceOre: parseKr(str(f, "price") || "0"),
  siblingDiscountPercent: Number(str(f, "siblingDiscount") || 0),
  capacity: str(f, "capacity") === "" ? null : Number(str(f, "capacity")),
  signupDeadline: opt(f, "signupDeadline"),
});

export async function newCamp(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/camps"), () => createCamp(db, ctx, str(formData, "clubId"), campInput(formData)));
  revalidatePath("/kasse/camps");
}

export async function editCamp(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/camps"), async () => updateCamp(db, ctx, str(formData, "campId"), campInput(formData), await deliverFromEnv()));
  revalidatePath("/kasse/camps");
}

export async function cancelCampAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/camps"), async () => cancelCamp(db, ctx, str(formData, "campId"), await deliverFromEnv()));
  revalidatePath("/kasse/camps");
}

export async function signUpCampAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/camps", () => signUpForCamp(db, ctx, str(formData, "campId"), str(formData, "profileId")));
  revalidatePath("/camps");
}

export async function cancelCampSignupAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = formData.get("clubId") ? kasse(formData, "/camps") : "/camps";
  await attempt(back, async () => cancelCampSignup(db, ctx, str(formData, "signupId"), await deliverFromEnv()));
  revalidatePath("/camps");
  revalidatePath("/kasse/camps");
}

// --- Booking af baner, haller og udstyr ---

const resourceInput = (f: FormData) => ({
  name: str(f, "name"),
  kind: str(f, "kind") as "court" | "hall" | "equipment",
  description: opt(f, "description"),
  quantity: Number(str(f, "quantity") || 1),
  pricePerHourOre: parseKr(str(f, "price") || "0"),
  requiresApproval: f.get("requiresApproval") === "1",
});

export async function newResource(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/booking"), () => createResource(db, ctx, str(formData, "clubId"), resourceInput(formData)));
  revalidatePath("/kasse/booking");
}

export async function editResource(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/booking"), () => updateResource(db, ctx, str(formData, "resourceId"), resourceInput(formData)));
  revalidatePath("/kasse/booking");
}

export async function archiveResourceAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/booking"), () => archiveResource(db, ctx, str(formData, "resourceId")));
  revalidatePath("/kasse/booking");
}

export async function bookResourceAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/booking", () =>
    createBooking(db, ctx, {
      resourceId: str(formData, "resourceId"),
      startsAt: parseLocalDateTime(str(formData, "startsAt")),
      endsAt: parseLocalDateTime(str(formData, "endsAt")),
      quantity: Number(str(formData, "quantity") || 1),
      note: opt(formData, "note"),
      teamId: opt(formData, "teamId"),
      profileId: opt(formData, "profileId") ?? undefined,
    }),
  );
  revalidatePath("/booking");
  revalidatePath("/kasse/booking");
}

export async function decideBookingAction(formData: FormData) {
  const { ctx } = await requireSession();
  const id = str(formData, "bookingId");
  await attempt(kasse(formData, "/booking"), async () =>
    formData.get("approve") === "1" ? approveBooking(db, ctx, id, await deliverFromEnv()) : rejectBooking(db, ctx, id, await deliverFromEnv()),
  );
  revalidatePath("/kasse/booking");
}

export async function cancelBookingAction(formData: FormData) {
  const { ctx } = await requireSession();
  const back = formData.get("clubId") ? kasse(formData, "/booking") : "/booking";
  await attempt(back, () => cancelBooking(db, ctx, str(formData, "bookingId")));
  revalidatePath("/booking");
  revalidatePath("/kasse/booking");
}

// --- Vagtplan, kontrakter og børneattester ---

const shiftInput = (f: FormData) => ({
  title: str(f, "title"),
  description: opt(f, "description"),
  location: opt(f, "location"),
  startsAt: parseLocalDateTime(str(f, "startsAt")),
  endsAt: parseLocalDateTime(str(f, "endsAt")),
  slots: Number(str(f, "slots") || 1),
  teamId: opt(f, "teamId"),
  requiresChildCertificate: f.get("requiresChildCertificate") === "1",
});

export async function newShiftAction(formData: FormData) {
  const { ctx } = await requireSession();
  // scope = "foreningsId|holdId" (holdId tomt for en vagt for hele foreningen)
  const [clubId, teamId] = str(formData, "scope").split("|");
  await attempt("/vagtplan", () => createShift(db, ctx, clubId, { ...shiftInput(formData), teamId: teamId || null }));
  revalidatePath("/vagtplan");
}

export async function editShiftAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/vagtplan", () => updateShift(db, ctx, str(formData, "shiftId"), shiftInput(formData)));
  revalidatePath("/vagtplan");
}

export async function cancelShiftAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/vagtplan", async () => cancelShift(db, ctx, str(formData, "shiftId"), await deliverFromEnv()));
  revalidatePath("/vagtplan");
}

export async function takeShiftAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/vagtplan", () => signUpForShift(db, ctx, str(formData, "shiftId"), opt(formData, "profileId") ?? undefined));
  revalidatePath("/vagtplan");
}

export async function leaveShiftAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/vagtplan", () => cancelShiftSignup(db, ctx, str(formData, "shiftId"), str(formData, "profileId")));
  revalidatePath("/vagtplan");
}

const clubPage = (f: FormData, path: string) => `/forening/${path}?klub=${encodeURIComponent(str(f, "clubId"))}`;

export async function newContractAction(formData: FormData) {
  const { ctx } = await requireSession();
  const krValue = str(formData, "amount");
  await attempt(clubPage(formData, "kontrakter"), () =>
    createContract(db, ctx, str(formData, "clubId"), {
      profileId: str(formData, "profileId"),
      kind: str(formData, "kind") as "coach" | "player" | "volunteer" | "other",
      title: str(formData, "title"),
      body: str(formData, "body"),
      startsOn: str(formData, "startsOn"),
      endsOn: opt(formData, "endsOn"),
      monthlyAmountOre: krValue ? parseKr(krValue) : null,
    }),
  );
  revalidatePath("/forening/kontrakter");
}

export async function editContractAction(formData: FormData) {
  const { ctx } = await requireSession();
  const krValue = str(formData, "amount");
  await attempt(clubPage(formData, "kontrakter"), () =>
    updateContract(db, ctx, str(formData, "contractId"), {
      kind: str(formData, "kind") as "coach" | "player" | "volunteer" | "other",
      title: str(formData, "title"),
      body: str(formData, "body"),
      startsOn: str(formData, "startsOn"),
      endsOn: opt(formData, "endsOn"),
      monthlyAmountOre: krValue ? parseKr(krValue) : null,
    }),
  );
  revalidatePath("/forening/kontrakter");
}

export async function contractStepAction(formData: FormData) {
  const { ctx } = await requireSession();
  const id = str(formData, "contractId");
  const step = str(formData, "step");
  await attempt(clubPage(formData, "kontrakter"), async () => {
    if (step === "send") return sendContract(db, ctx, id, await deliverFromEnv());
    if (step === "cancel") return cancelContract(db, ctx, id);
    if (step === "delete") return deleteDraftContract(db, ctx, id);
    throw new Error("Ukendt handling.");
  });
  revalidatePath("/forening/kontrakter");
}

export async function signContractAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/kontrakter", () => signContract(db, ctx, str(formData, "contractId"), str(formData, "name")));
  revalidatePath("/kontrakter");
}

export async function declineContractAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/kontrakter", () => declineContract(db, ctx, str(formData, "contractId"), opt(formData, "reason")));
  revalidatePath("/kontrakter");
}

export async function requireCertificateAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(clubPage(formData, "attester"), () => requireCertificate(db, ctx, str(formData, "clubId"), str(formData, "profileId"), opt(formData, "reason")));
  revalidatePath("/forening/attester");
}

export async function certificateStepAction(formData: FormData) {
  const { ctx } = await requireSession();
  const id = str(formData, "certificateId");
  const step = str(formData, "step");
  await attempt(clubPage(formData, "attester"), async () => {
    if (step === "written") return recordWrittenConsent(db, ctx, id);
    if (step === "requested") return markCertificateRequested(db, ctx, id);
    if (step === "approved") return registerCertificateResult(db, ctx, id, { approved: true, issuedOn: opt(formData, "issuedOn"), expiresOn: opt(formData, "expiresOn") });
    if (step === "not_approved") return registerCertificateResult(db, ctx, id, { approved: false });
    if (step === "remove") return removeCertificate(db, ctx, id);
    throw new Error("Ukendt handling.");
  });
  revalidatePath("/forening/attester");
}

export async function giveCertificateConsentAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt("/vagtplan", () => giveCertificateConsent(db, ctx, str(formData, "certificateId")));
  revalidatePath("/vagtplan");
}

// --- Billetsalg ---

const ticketInput = (f: FormData) => ({
  name: str(f, "name"),
  description: opt(f, "description"),
  location: opt(f, "location"),
  startsAt: parseLocalDateTime(str(f, "startsAt")),
  priceOre: parseKr(str(f, "price") || "0"),
  capacity: str(f, "capacity") === "" ? null : Number(str(f, "capacity")),
  saleClosesAt: opt(f, "saleClosesAt") ? parseLocalDateTime(str(f, "saleClosesAt")) : null,
  maxPerOrder: Number(str(f, "maxPerOrder") || 10),
});

export async function newTicketEvent(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/billetter"), () => createTicketEvent(db, ctx, str(formData, "clubId"), ticketInput(formData)));
  revalidatePath("/kasse/billetter");
  redirect(kasse(formData, "/billetter"));
}

export async function editTicketEvent(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/billetter"), () => updateTicketEvent(db, ctx, str(formData, "ticketEventId"), ticketInput(formData)));
  revalidatePath("/kasse/billetter");
  redirect(kasse(formData, "/billetter"));
}

export async function cancelTicketEventAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/billetter"), () => cancelTicketEvent(db, ctx, str(formData, "ticketEventId"), paymentProviderOrUndefined()));
  revalidatePath("/kasse/billetter");
  redirect(kasse(formData, "/billetter"));
}

export async function refundTicketOrderAction(formData: FormData) {
  const { ctx } = await requireSession();
  await attempt(kasse(formData, "/billetter"), () => refundTicketOrder(db, ctx, str(formData, "orderId"), getPaymentProvider()));
  revalidatePath("/kasse/billetter");
  redirect(kasse(formData, "/billetter"));
}

export interface BuyTicketsState {
  error?: string;
  values?: Record<string, string>;
}

/** Den åbne billetside. Ingen login; honeypot-feltet "website" skal være tomt. */
export async function buyTicketsAction(ticketEventId: string, _: BuyTicketsState, formData: FormData): Promise<BuyTicketsState> {
  const values = Object.fromEntries([...formData.entries()].filter(([, v]) => typeof v === "string")) as Record<string, string>;
  if (str(formData, "website")) return { error: "Noget gik galt. Prøv igen om lidt." };
  let url: string;
  try {
    const result = await createTicketOrder(
      db,
      ticketEventId,
      { name: str(formData, "name"), email: str(formData, "email"), quantity: Number(str(formData, "quantity") || 1), acceptTerms: formData.get("acceptTerms") === "on" },
      getPaymentProvider(),
      await origin(),
      sendMail,
      new Date(),
      ((await headers()).get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
    );
    url = result.redirectUrl;
  } catch (e) {
    const technical = e instanceof Error && (("cause" in e && !!e.cause) || e.message.startsWith("Failed query"));
    if (technical || !(e instanceof Error)) console.error(e);
    return { error: e instanceof Error && !technical ? e.message : "Noget gik galt. Prøv igen om lidt.", values };
  }
  redirect(url);
}

export async function completeTestTicketPayment(formData: FormData) {
  if (!mockPaymentsEnabled()) throw new Error("Testbetaling er slået fra");
  const sessionId = str(formData, "session");
  const back = `/billetter/test/${sessionId}`;
  let token: string | null = null;
  await attempt(back, async () => {
    const done = await completeTicketOrder(db, sessionId);
    if (!done) throw new Error("Betalingen findes ikke");
    token = done.accessToken;
    if (!done.alreadyDone) await sendTicketMail(db, done.orderId, sendMail, await origin());
  });
  redirect(`/billetter/ordre/${token}`);
}

export async function admitTicketAction(formData: FormData) {
  const { ctx } = await requireSession();
  const code = str(formData, "code");
  await attempt(`/billet/${code}`, () => admitTicket(db, ctx, code));
  redirect(`/billet/${code}`);
}

// --- Selvbetjent oprettelse af forening ---

export async function registerClubAction(formData: FormData) {
  const { ctx } = await requireSession("/opret-forening");
  let clubId = "";
  await attempt("/opret-forening", async () => {
    if (formData.get("terms") !== "on") throw new Error("Du skal bekræfte, at du må oprette foreningen.");
    clubId = (await registerClub(db, ctx, { name: str(formData, "name"), slug: opt(formData, "slug") })).id;
  });
  redirect(`/forening/kom-i-gang?klub=${clubId}`);
}
