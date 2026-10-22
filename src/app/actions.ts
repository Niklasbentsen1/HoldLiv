"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { canActAs } from "../auth/permissions";
import { respondToEvent } from "../services";
import { db } from "../lib/db";
import { ACTING_COOKIE, USER_COOKIE, getSession } from "../lib/session";

export async function demoLogin(formData: FormData) {
  const jar = await cookies();
  jar.set(USER_COOKIE, String(formData.get("userId")), { httpOnly: true, sameSite: "lax" });
  jar.delete(ACTING_COOKIE);
  revalidatePath("/");
}

export async function logout() {
  const jar = await cookies();
  jar.delete(USER_COOKIE);
  jar.delete(ACTING_COOKIE);
  revalidatePath("/");
}

export async function switchProfile(formData: FormData) {
  const session = await getSession();
  const profileId = String(formData.get("profileId"));
  if (!session || !canActAs(session.ctx, profileId)) return;
  (await cookies()).set(ACTING_COOKIE, profileId, { httpOnly: true, sameSite: "lax" });
  revalidatePath("/");
}

export async function respond(formData: FormData) {
  const session = await getSession();
  if (!session) return;
  const status = String(formData.get("status")) as "yes" | "no" | "maybe";
  await respondToEvent(db, session.ctx, String(formData.get("eventId")), session.actingProfileId, status);
  revalidatePath("/");
}
