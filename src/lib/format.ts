import { TIME_ZONE } from "./time";

export const TYPE_LABEL = { training: "Træning", match: "Kamp", tournament: "Stævne", social: "Socialt", other: "Aktivitet" } as const;
export const STATUS_LABEL = { yes: "Kommer", maybe: "Måske", no: "Kommer ikke" } as const;
export const STATUSES = ["yes", "maybe", "no"] as const;

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("da-DK", { timeZone: TIME_ZONE, ...opts });
const dayFmt = fmt({ weekday: "long", day: "numeric", month: "long" });
const shortDayFmt = fmt({ weekday: "short", day: "numeric", month: "short" });
const timeFmt = fmt({ hour: "2-digit", minute: "2-digit" });
const tinyFmt = fmt({ day: "numeric", month: "numeric" });

export const day = (d: Date) => dayFmt.format(d);
export const shortDay = (d: Date) => shortDayFmt.format(d);
export const time = (d: Date) => timeFmt.format(d);
export const tinyDate = (d: Date) => tinyFmt.format(d);
export const when = (start: Date, end?: Date | null) => `${day(start)} kl. ${time(start)}${end ? `–${time(end)}` : ""}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const dayHeading = (d: Date) => cap(day(d));
