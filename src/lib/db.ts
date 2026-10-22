import { createDb, type Db } from "../db/client";

// Én forbindelsespulje pr. serverproces, også under hot reload i udvikling.
const g = globalThis as unknown as { holdlivDb?: Db };
export const db: Db = (g.holdlivDb ??= createDb().db);
