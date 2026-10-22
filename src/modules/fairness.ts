// Retfærdig fordeling af opgaver på familier. Ren logik uden database.
//
// Reglen: hver opgave går til den familie, der indtil nu har fået færrest opgaver. Ved lighed vælges
// den, der længst har været uden en opgave, og derefter efter navn, så resultatet er det samme hver gang.
// Familier, der har meldt fra til opgavens aktivitet, springes over, medmindre alle har meldt fra.

export interface FamilyLoad {
  /** Familiens nøgle. Søskende på samme hold deler nøgle, så de kun tæller som én familie. */
  key: string;
  /** Spilleren opgaven skrives på. */
  assigneeId: string;
  name: string;
  /** Antal opgaver familien allerede har haft af samme slags. */
  load: number;
  /** Hvornår familien sidst fik en opgave (millisekunder; 0 = aldrig). */
  lastAt: number;
}

export interface Distributable {
  id: string;
  /** Familienøgler, der ikke bør have opgaven. */
  skip?: ReadonlySet<string>;
}

export function distribute(families: readonly FamilyLoad[], items: readonly Distributable[]): Map<string, string> {
  const state = families.map((f) => ({ ...f }));
  const out = new Map<string, string>();
  let tick = 0;
  for (const item of items) {
    if (state.length === 0) break;
    const allowed = state.filter((f) => !item.skip?.has(f.key));
    const pool = allowed.length ? allowed : state;
    const pick = pool.reduce((best, f) =>
      f.load !== best.load ? (f.load < best.load ? f : best) : f.lastAt !== best.lastAt ? (f.lastAt < best.lastAt ? f : best) : f.name.localeCompare(best.name, "da") < 0 ? f : best,
    );
    out.set(item.id, pick.assigneeId);
    pick.load += 1;
    pick.lastAt = Number.MAX_SAFE_INTEGER / 2 + ++tick;
  }
  return out;
}
