import type { NextRequest } from "next/server";
import { deleteSession } from "../../../../auth/login";
import { db } from "../../../../lib/db";
import { guard, ok } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return guard(async () => {
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (token) await deleteSession(db, token);
    return ok();
  });
}
