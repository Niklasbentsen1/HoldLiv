// Rettighedsmotoren. Ren logik uden database, så den kan testes og genbruges
// i web, app og senere AI-medlemsservicens værktøjer.
//
// Regel: alle tjek spørger "må dette login gøre X ved denne ressource?".
// "Agér som barn" er et visningsvalg i appen. Det giver ingen ekstra rettigheder;
// forælderen må melde barnet til, fordi forælderen er værge for barnet.

export type ClubId = string;
export type TeamId = string;
export type ProfileId = string;

/** Alt hvad vi ved om det login, der spørger. Bygges af loadAccessContext(). */
export interface AccessContext {
  userId: string;
  /** Login'ets egen profil. */
  profileId: ProfileId;
  /** Foreninger hvor egen profil er admin. */
  adminClubs: ReadonlySet<ClubId>;
  /** Foreninger hvor egen profil er kasserer. */
  treasurerClubs: ReadonlySet<ClubId>;
  /** Hold hvor egen profil er træner. */
  coachTeams: ReadonlySet<TeamId>;
  /** Børneprofiler som login'et aktuelt er værge for (under 18 år). */
  wards: ReadonlySet<ProfileId>;
  /** Tidspunktet tjekket gælder for, fx til svarfrister. */
  now: Date;
}

/** Fakta om en profil, som et tjek kan have brug for. */
export interface ProfileFacts {
  profileId: ProfileId;
  clubIds: readonly ClubId[];
  /** Hold hvor profilen er spiller eller træner. */
  teamIds: readonly TeamId[];
}

export interface TeamFacts {
  teamId: TeamId;
  clubId: ClubId;
}

export interface EventFacts {
  teamId: TeamId;
  clubId: ClubId;
  startsAt?: Date;
  /** Svarfrist. Uden frist lukker svarene, når aktiviteten starter. */
  responseDeadline?: Date | null;
  cancelled?: boolean;
}

export type Permission =
  | { action: "club.manage"; clubId: ClubId }
  | { action: "club.view"; clubId: ClubId; memberProfileIds: readonly ProfileId[] }
  | { action: "team.create"; clubId: ClubId }
  | { action: "team.manage"; team: TeamFacts }
  | { action: "team.view"; team: TeamFacts; memberProfileIds: readonly ProfileId[] }
  | { action: "team.players.manage"; team: TeamFacts }
  | { action: "team.coaches.manage"; team: TeamFacts }
  | { action: "module.toggle"; team: TeamFacts }
  | { action: "module.configure"; team: TeamFacts }
  | { action: "event.manage"; event: EventFacts }
  | { action: "event.respond"; event: EventFacts; profile: ProfileFacts }
  | { action: "profile.view"; profile: ProfileFacts }
  | { action: "profile.edit"; profile: ProfileFacts }
  | { action: "profile.guardians.manage"; profile: ProfileFacts }
  | { action: "profile.actAs"; profileId: ProfileId }
  | { action: "finance.manage"; clubId: ClubId }
  | { action: "charge.pay"; profileId: ProfileId };

export type Action = Permission["action"];

const isAdmin = (ctx: AccessContext, clubId: ClubId) => ctx.adminClubs.has(clubId);
const isCoach = (ctx: AccessContext, team: TeamFacts) => ctx.coachTeams.has(team.teamId);
const leadsTeam = (ctx: AccessContext, team: TeamFacts) => isAdmin(ctx, team.clubId) || isCoach(ctx, team);

/** Egen profil eller et barn man er værge for. */
export function canActAs(ctx: AccessContext, profileId: ProfileId): boolean {
  return profileId === ctx.profileId || ctx.wards.has(profileId);
}

const adminOfProfile = (ctx: AccessContext, p: ProfileFacts) => p.clubIds.some((c) => ctx.adminClubs.has(c));
const treasurerOfProfile = (ctx: AccessContext, p: ProfileFacts) => p.clubIds.some((c) => ctx.treasurerClubs.has(c));
/** Admin eller kasserer: medlemslisten, kontingenter og betalinger. */
const handlesFinance = (ctx: AccessContext, clubId: ClubId) => isAdmin(ctx, clubId) || ctx.treasurerClubs.has(clubId);
const coachOfProfile = (ctx: AccessContext, p: ProfileFacts) => p.teamIds.some((t) => ctx.coachTeams.has(t));

export function can(ctx: AccessContext, perm: Permission): boolean {
  switch (perm.action) {
    case "club.manage":
    case "team.create":
      return isAdmin(ctx, perm.clubId);

    case "club.view":
      return isAdmin(ctx, perm.clubId) || perm.memberProfileIds.some((p) => canActAs(ctx, p));

    case "team.manage":
    case "module.configure":
    case "team.players.manage":
    case "event.manage":
      return leadsTeam(ctx, "team" in perm ? perm.team : perm.event);

    // Foreningen bestemmer hvilke moduler et hold har; træneren stiller indstillingerne.
    case "module.toggle":
    case "team.coaches.manage":
      return isAdmin(ctx, perm.team.clubId);

    case "team.view":
      return leadsTeam(ctx, perm.team) || perm.memberProfileIds.some((p) => canActAs(ctx, p));

    case "event.respond": {
      const { event, profile } = perm;
      if (event.cancelled || !profile.teamIds.includes(event.teamId)) return false;
      // Træner/admin kan altid registrere fremmøde, også efter fristen.
      if (leadsTeam(ctx, event)) return true;
      // Spilleren selv eller forælderen, indtil svarfristen.
      const closesAt = event.responseDeadline ?? event.startsAt;
      const open = !closesAt || ctx.now.getTime() < closesAt.getTime();
      return canActAs(ctx, profile.profileId) && open;
    }

    case "profile.view":
      return (
        canActAs(ctx, perm.profile.profileId) ||
        adminOfProfile(ctx, perm.profile) ||
        treasurerOfProfile(ctx, perm.profile) ||
        coachOfProfile(ctx, perm.profile)
      );

    case "profile.edit":
    case "profile.guardians.manage":
      // Trænere styrer spillerne på holdet (team.players.manage),
      // men retter ikke personoplysninger. Det gør personen selv, forælderen eller admin.
      return canActAs(ctx, perm.profile.profileId) || adminOfProfile(ctx, perm.profile);

    case "profile.actAs":
      return canActAs(ctx, perm.profileId);

    case "finance.manage":
      return handlesFinance(ctx, perm.clubId);

    case "charge.pay":
      // Man betaler for sig selv og sine børn. Kassereren registrerer betalinger, men betaler ikke på andres vegne.
      return canActAs(ctx, perm.profileId);
  }
}

export class ForbiddenError extends Error {
  constructor(public readonly action: Action) {
    super(`Ingen adgang: ${action}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(ctx: AccessContext, perm: Permission): void {
  if (!can(ctx, perm)) throw new ForbiddenError(perm.action);
}

/** Myndighedsalder. Værgens rettigheder ophører automatisk, når barnet fylder 18. */
export const AGE_OF_MAJORITY = 18;

export function isMinor(birthDate: string | null, today: Date = new Date()): boolean {
  // Uden fødselsdato antager vi barn, så forælderen ikke mister adgang ved en tastefejl.
  if (!birthDate) return true;
  const [y, m, d] = birthDate.split("-").map(Number);
  const eighteenth = new Date(Date.UTC(y + AGE_OF_MAJORITY, m - 1, d));
  return today.getTime() < eighteenth.getTime();
}
