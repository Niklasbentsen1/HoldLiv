// Beløb og kontingentperioder. Beløb er i øre; datoer er "YYYY-MM-DD" i dansk tid.
import { TIME_ZONE } from "./time";

export type FeeInterval = "month" | "quarter" | "half_year" | "year";

export const INTERVAL_LABEL: Record<FeeInterval, string> = {
  month: "pr. måned",
  quarter: "pr. kvartal",
  half_year: "pr. halvår",
  year: "pr. år",
};
const MONTHS: Record<FeeInterval, number> = { month: 1, quarter: 3, half_year: 6, year: 12 };

const krFmt = new Intl.NumberFormat("da-DK", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
export const kr = (ore: number) => `${krFmt.format(ore / 100)} kr.`;

/** "650", "650,50" eller "1.100" -> øre. */
export function parseKr(value: string): number {
  const clean = value.replace(/\s|kr\.?/gi, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) throw new Error("Skriv beløbet i kroner, fx 650 eller 650,50");
  return Math.round(Number(clean) * 100);
}

/** Dagens dato i dansk tid. */
export const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(d);

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return iso(y, m, d + days);
}

/** Perioder følger kalenderen: måneder, kvartaler, halvår (jan–jun, jul–dec) og år. */
export function periodContaining(interval: FeeInterval, date: string) {
  const [y, m] = date.split("-").map(Number);
  const len = MONTHS[interval];
  const startMonth = Math.floor((m - 1) / len) * len + 1;
  return { start: iso(y, startMonth, 1), end: iso(y, startMonth + len, 0) };
}

export const nextPeriod = (interval: FeeInterval, start: string) =>
  periodContaining(interval, addDays(periodContaining(interval, start).end, 1));

const monthName = (m: number) => new Intl.DateTimeFormat("da-DK", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, m - 1, 1)));

/** "2. halvår 2026", "4. kvartal 2026", "oktober 2026" eller "2026". */
export function periodLabel(interval: FeeInterval, start: string): string {
  const [y, m] = start.split("-").map(Number);
  switch (interval) {
    case "year":
      return String(y);
    case "half_year":
      return `${m <= 6 ? 1 : 2}. halvår ${y}`;
    case "quarter":
      return `${Math.floor((m - 1) / 3) + 1}. kvartal ${y}`;
    case "month":
      return `${monthName(m)} ${y}`;
  }
}

const dateFmt = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
/** "2026-10-31" -> "31. oktober 2026". */
export const longDate = (date: string) => dateFmt.format(new Date(`${date}T00:00:00Z`));
