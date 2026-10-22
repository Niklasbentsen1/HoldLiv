// Tid i HoldLiv regnes i dansk vægur-tid. En træning kl. 17 er kl. 17 både før og efter
// skiftet til vintertid, så serier og formularer kan ikke bare lægge 7 × 24 timer til.
export const TIME_ZONE = "Europe/Copenhagen";

const parts = (d: Date, tz: string) => {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
};

/** Forskel mellem tidszonens vægur og UTC i millisekunder på et givet tidspunkt. */
const offsetAt = (d: Date, tz: string) => {
  const p = parts(d, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - Math.floor(d.getTime() / 60000) * 60000;
};

/** Vægur-tid i tidszonen -> UTC-tidspunkt. */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz = TIME_ZONE): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - offsetAt(new Date(guess), tz);
  // Anden runde rammer rigtigt, hvis første gæt lå på den anden side af et tidsskift.
  return new Date(guess - offsetAt(new Date(first), tz));
}

/** Samme klokkeslæt et antal dage senere i tidszonen. */
export function addLocalDays(date: Date, days: number, tz = TIME_ZONE): Date {
  const p = parts(date, tz);
  return zonedTime(p.y, p.m, p.d + days, p.h, p.min, tz);
}

/** Værdi fra <input type="datetime-local"> ("2026-10-27T17:00") tolket som dansk tid. */
export function parseLocalDateTime(value: string, tz = TIME_ZONE): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) throw new Error("Ugyldigt tidspunkt");
  return zonedTime(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}

/** UTC-tidspunkt -> værdi til <input type="datetime-local"> i dansk tid. */
export function toLocalInput(date: Date, tz = TIME_ZONE): string {
  const p = parts(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}
