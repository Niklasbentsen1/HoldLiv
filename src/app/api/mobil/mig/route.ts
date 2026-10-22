import type { NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { mobilePeople } from "../../../../services";
import { authed, guard, ok } from "../_lib";

export const dynamic = "force-dynamic";

/** Hvem er jeg, og hvem kan jeg handle for (mig selv og mine børn)? */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const { ctx } = await authed(req);
    return ok({ people: await mobilePeople(db, ctx) });
  });
}
