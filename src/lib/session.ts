// Demo-login: login'ets id gemmes i en cookie. Erstattes af rigtig login (fx MitID/magic link) senere.
import { cookies } from "next/headers";
import { loadAccessContext } from "../auth/context";
import { canActAs } from "../auth/permissions";
import { db } from "./db";

export const USER_COOKIE = "holdliv_user";
export const ACTING_COOKIE = "holdliv_acting";

export async function getSession() {
  const jar = await cookies();
  const userId = jar.get(USER_COOKIE)?.value;
  if (!userId) return null;
  const ctx = await loadAccessContext(db, userId).catch(() => null);
  if (!ctx) return null;
  const wanted = jar.get(ACTING_COOKIE)?.value;
  const actingProfileId = wanted && canActAs(ctx, wanted) ? wanted : ctx.profileId;
  return { ctx, actingProfileId };
}
