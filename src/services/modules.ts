// Modulmotoren: hvilke moduler hvert hold bruger, og modulernes indstillinger.
// Foreningens admin slår moduler til og fra pr. hold; træneren stiller indstillingerne.
// Modulernes egne funktioner kalder requireModule() først, så et slukket modul er helt lukket.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { teamModules, teams } from "../db/schema";
import { assertCan, can, type AccessContext } from "../auth/permissions";
import { loadTeamFacts, loadTeamMemberIds } from "../auth/context";
import { defaultConfig, MODULES, parseConfig, type ModuleConfig, type ModuleDef, type Registry } from "../modules/registry";

function moduleDef(key: string, registry: Registry): ModuleDef {
  const def = registry[key];
  if (!def) throw new Error("Ukendt modul.");
  return def;
}

/** Slå til: kun moduler der er bygget. Slå fra er altid tilladt. */
function assertAvailable(def: ModuleDef) {
  if (!def.available) throw new Error(`${def.name} er ikke klar endnu.`);
}

export interface TeamModuleState {
  key: string;
  name: string;
  description: string;
  path: string;
  available: boolean;
  enabled: boolean;
  config: ModuleConfig;
  fields: ModuleDef["fields"];
}

/** Alle moduler med status for ét hold. Kræver at man må se holdet. */
export async function listTeamModules(db: Db, ctx: AccessContext, teamId: string, registry: Registry = MODULES) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.view", team, memberProfileIds: await loadTeamMemberIds(db, teamId) });
  const rows = await db.select().from(teamModules).where(eq(teamModules.teamId, teamId));
  const byKey = new Map(rows.map((r) => [r.module, r]));
  return Object.values(registry).map<TeamModuleState>((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      name: def.name,
      description: def.description,
      path: def.path,
      available: def.available,
      enabled: !!row?.enabled && def.available,
      config: { ...defaultConfig(def), ...(row ? parseConfigSafe(def, row.config) : {}) },
      fields: def.fields,
    };
  });
}

/** Gemte indstillinger kan være fra en ældre version; ugyldige felter falder tilbage til standard. */
function parseConfigSafe(def: ModuleDef, raw: Record<string, unknown>): ModuleConfig {
  try {
    return parseConfig(def, raw);
  } catch {
    return defaultConfig(def);
  }
}

/** Modulerne som er slået til for holdet, til menuen på holdets side. */
export async function listEnabledModules(db: Db, ctx: AccessContext, teamId: string, registry: Registry = MODULES) {
  return (await listTeamModules(db, ctx, teamId, registry)).filter((m) => m.enabled);
}

/**
 * Bruges af modulernes egne funktioner. Tjekker at modulet er slået til for holdet og at
 * man må se holdet, og returnerer holdets indstillinger for modulet.
 */
export async function requireModule(db: Db, ctx: AccessContext, teamId: string, key: string, registry: Registry = MODULES) {
  const def = moduleDef(key, registry);
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.view", team, memberProfileIds: await loadTeamMemberIds(db, teamId) });
  const [row] = await db
    .select()
    .from(teamModules)
    .where(and(eq(teamModules.teamId, teamId), eq(teamModules.module, key)));
  if (!def.available || !row?.enabled) throw new Error(`${def.name} er ikke slået til for holdet.`);
  return { team, config: { ...defaultConfig(def), ...parseConfigSafe(def, row.config) } };
}

async function upsert(db: Pick<Db, "insert">, ctx: AccessContext, teamId: string, key: string, enabled: boolean, config?: ModuleConfig) {
  await db
    .insert(teamModules)
    .values({ teamId, module: key, enabled, config: config ?? {}, updatedByUserId: ctx.userId })
    .onConflictDoUpdate({
      target: [teamModules.teamId, teamModules.module],
      set: { enabled, ...(config ? { config } : {}), updatedByUserId: ctx.userId, updatedAt: new Date() },
    });
}

/** Admin slår et modul til eller fra for ét hold. Indstillinger og data bevares, hvis det slås fra. */
export async function setTeamModule(
  db: Db,
  ctx: AccessContext,
  teamId: string,
  key: string,
  enabled: boolean,
  registry: Registry = MODULES,
) {
  const def = moduleDef(key, registry);
  assertCan(ctx, { action: "module.toggle", team: await loadTeamFacts(db, teamId) });
  if (enabled) assertAvailable(def);
  await upsert(db, ctx, teamId, key, enabled);
}

/**
 * Admin slår et modul til eller fra for flere hold ad gangen, fx alle U10-hold.
 * Alle holdene skal høre til samme forening, ellers sker der ingenting.
 */
export async function setModuleForTeams(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  key: string,
  teamIds: string[],
  enabled: boolean,
  registry: Registry = MODULES,
) {
  const def = moduleDef(key, registry);
  assertCan(ctx, { action: "club.manage", clubId });
  if (enabled) assertAvailable(def);
  if (teamIds.length === 0) return 0;
  const owned = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.clubId, clubId), inArray(teams.id, teamIds)));
  if (owned.length !== new Set(teamIds).size) throw new Error("Et af holdene hører ikke til foreningen.");
  await db.transaction(async (tx) => {
    for (const t of owned) await upsert(tx, ctx, t.id, key, enabled);
  });
  return owned.length;
}

/** Træner eller admin retter modulets indstillinger for holdet. */
export async function updateModuleConfig(
  db: Db,
  ctx: AccessContext,
  teamId: string,
  key: string,
  raw: Record<string, unknown>,
  registry: Registry = MODULES,
) {
  const def = moduleDef(key, registry);
  assertCan(ctx, { action: "module.configure", team: await loadTeamFacts(db, teamId) });
  const config = parseConfig(def, raw);
  const [row] = await db
    .select({ enabled: teamModules.enabled })
    .from(teamModules)
    .where(and(eq(teamModules.teamId, teamId), eq(teamModules.module, key)));
  await upsert(db, ctx, teamId, key, row?.enabled ?? false, config);
}

/** Oversigt til foreningens side: hvert hold og hvilke moduler det bruger. */
export async function moduleMatrix(db: Db, ctx: AccessContext, clubId: string, registry: Registry = MODULES) {
  assertCan(ctx, { action: "club.manage", clubId });
  const [teamRows, rows] = await Promise.all([
    db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.clubId, clubId)).orderBy(asc(teams.name)),
    db
      .select({ teamId: teamModules.teamId, module: teamModules.module, enabled: teamModules.enabled })
      .from(teamModules)
      .innerJoin(teams, eq(teams.id, teamModules.teamId))
      .where(eq(teams.clubId, clubId)),
  ]);
  const on = new Set(rows.filter((r) => r.enabled).map((r) => `${r.teamId}:${r.module}`));
  return {
    modules: Object.values(registry).map(({ key, name, description, available }) => ({ key, name, description, available })),
    teams: teamRows.map((t) => ({
      ...t,
      enabled: Object.fromEntries(Object.keys(registry).map((k) => [k, on.has(`${t.id}:${k}`) && registry[k].available])) as Record<string, boolean>,
    })),
  };
}
