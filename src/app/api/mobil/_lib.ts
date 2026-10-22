// Fælles hjælp til mobilappens JSON-endpoints.
import type { NextRequest } from "next/server";
import { db } from "../../../lib/db";
import { authenticateMobile } from "../../../services";

export { bodyOf, guard, ok, text, uuid } from "../../../lib/mobileHttp";

export const dynamic = "force-dynamic";

export const authed = (req: NextRequest) => authenticateMobile(db, req.headers.get("authorization"));
