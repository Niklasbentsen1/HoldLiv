// Fælles byggeklodser til HoldLivs udseende. Brug dem frem for at style direkte på siderne.
import Link from "next/link";
import type { ReactNode } from "react";
import { TYPE_LABEL } from "../lib/format";

const PATHS = {
  home: "M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z",
  family: "M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 19c0-3 2.5-5.5 5.5-5.5S14 16 14 19M14.5 14.2c.6-.4 1.3-.7 2-.7 2.5 0 4.5 2 4.5 4.5",
  club: "M12 3 4.5 6v5.5c0 4.4 3.1 8.3 7.5 9.5 4.4-1.2 7.5-5.1 7.5-9.5V6z M9 12l2 2 4-4",
  calendar: "M5 6.5h14a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1ZM4 10.5h16M8.5 4v4M15.5 4v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v4.5l3 2",
  pin: "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.3c2 .8 3.5 2.8 3.5 5.7",
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14M13 6l6 6-6 6",
  back: "M19 12H5M11 6l-6 6 6 6",
  chart: "M5 20V10M12 20V4M19 20v-7",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0",
  logout: "M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 16l4-4-4-4M14 12H4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3A4 4 0 0 0 13 5.3l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1",
  check: "M5 12.5 10 17l9-10",
  x: "M6 6l12 12M18 6 6 18",
  whistle: "M3 9h9.5a5.5 5.5 0 1 1-5.4 6.5L3 13.5zM12 6.5V4h4",
  ball: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8l3.8 2.8-1.5 4.4H9.7l-1.5-4.4zM12 3v5M20.6 9.6l-4.8 1.2M17.6 19.2l-3.3-4M6.4 19.2l3.3-4M3.4 9.6l4.8 1.2",
  star: "M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  card: "M4 6.5h16a1 1 0 0 1 1 1V17a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1ZM3 10.5h18M7 14.5h3",
  coins: "M9 10c3.3 0 6-1.3 6-3s-2.7-3-6-3-6 1.3-6 3 2.7 3 6 3ZM3 7v5c0 1.7 2.7 3 6 3M15 7v2M15 13c3.3 0 6-1.3 6-3M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-7",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Ikon pr. aktivitetstype. */
export const TYPE_ICON: Record<keyof typeof TYPE_LABEL, IconName> = { training: "whistle", match: "ball", other: "star" };

// Stabil farve ud fra et navn, så samme person/hold altid har samme farve.
const HUES = ["#6f93ff", "#ff7a45", "#b08cff", "#1f9d5b", "#e19a12", "#ef5d8f", "#2bb3c0", "#8a9a2b"];
export function hueFor(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

export function Avatar({ name, size = 36, ring }: { name: string; size?: number; ring?: boolean }) {
  return (
    <span className={ring ? "avatar ring" : "avatar"} style={{ width: size, height: size, background: hueFor(name), fontSize: size * 0.38 }} title={name}>
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ names, max = 5, size = 30 }: { names: string[]; max?: number; size?: number }) {
  const shown = names.slice(0, max);
  return (
    <span className="avatar-stack">
      {shown.map((n, i) => (
        <Avatar key={`${n}-${i}`} name={n} size={size} ring />
      ))}
      {names.length > max && (
        <span className="avatar ring more" style={{ width: size, height: size, fontSize: size * 0.36 }}>
          +{names.length - max}
        </span>
      )}
    </span>
  );
}

/** Holdets "skjold": initialer i et våbenskjold i holdets faste farve. */
export function Crest({ name, size = 44 }: { name: string; size?: number }) {
  const color = hueFor(name);
  const words = name.trim().split(/\s+/);
  const short = (words.find((w) => /\d/.test(w)) ?? words.slice(0, 2).map((w) => w[0]).join("")).slice(0, 3).toUpperCase();
  return (
    <svg width={size} height={size * 1.1} viewBox="0 0 40 44" className="crest" aria-hidden>
      <path d="M20 1.5 37 7v13.5C37 31 29.8 39.6 20 42.5 10.2 39.6 3 31 3 20.5V7z" fill={color} />
      <path d="M20 1.5 37 7v13.5C37 31 29.8 39.6 20 42.5z" fill="#000" opacity="0.12" />
      <text x="20" y="25.5" textAnchor="middle" fontSize={short.length > 2 ? 11 : 13} fontWeight={800} fill="#fff" fontFamily="var(--font)">
        {short}
      </text>
    </svg>
  );
}

/** Procent som ring. value 0-100, null vises som tom ring. */
export function Ring({ value, size = 64, stroke = 8, label, tone = "brand" }: { value: number | null; size?: number; stroke?: number; label?: string; tone?: "brand" | "yes" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className={`ring-chart ${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} className="track" fill="none" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          className="value"
          strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-label">{label ?? (value === null ? "–" : `${Math.round(v)}%`)}</span>
    </span>
  );
}

/** Lille søjlediagram, fx aktiviteter pr. dag. */
export function Bars({ values, labels, highlight }: { values: number[]; labels?: string[]; highlight?: number }) {
  const max = Math.max(1, ...values);
  return (
    <span className="bars">
      {values.map((v, i) => (
        <span key={i} className={i === highlight ? "bar on" : "bar"}>
          <span className="fill" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} data-empty={v === 0 || undefined} />
          {labels && <span className="bar-label">{labels[i]}</span>}
        </span>
      ))}
    </span>
  );
}

export function Stat({ label, value, icon, hint, tone, children }: { label: string; value: ReactNode; icon?: IconName; hint?: ReactNode; tone?: "brand" | "tint"; children?: ReactNode }) {
  return (
    <div className={tone ? `stat card ${tone}` : "stat card"}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {icon && (
          <span className="icon-bubble">
            <Icon name={icon} size={18} />
          </span>
        )}
      </div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
      {children}
    </div>
  );
}

export function TypeBadge({ type }: { type: keyof typeof TYPE_LABEL }) {
  return (
    <span className={`badge ${type}`}>
      <Icon name={TYPE_ICON[type]} size={14} />
      {TYPE_LABEL[type]}
    </span>
  );
}

/** Dato som lille "billet": ugedag, dagnummer og måned. */
export function DateTile({ date, type }: { date: Date; type?: keyof typeof TYPE_LABEL }) {
  const p = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", weekday: "short", day: "numeric", month: "short" }).formatToParts(date);
  const get = (t: string) => p.find((x) => x.type === t)?.value.replace(".", "") ?? "";
  return (
    <span className={`date-tile ${type ?? ""}`}>
      <span className="dt-wd">{get("weekday")}</span>
      <span className="dt-d">{get("day")}</span>
      <span className="dt-m">{get("month")}</span>
    </span>
  );
}

/** Sidehoved med tilbagelink, titel, undertekst og handlinger. */
export function PageHead({ back, title, sub, actions, kicker }: { back?: { href: string; label: string }; title?: ReactNode; sub?: ReactNode; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <div className="page-head">
      {back && (
        <Link href={back.href} className="back">
          <Icon name="back" size={16} /> {back.label}
        </Link>
      )}
      {(title || actions) && (
        <div className="page-head-row">
          <div>
            {kicker && <div className="kicker">{kicker}</div>}
            {title && <h1>{title}</h1>}
            {sub && <p className="sub">{sub}</p>}
          </div>
          {actions && <div className="head-actions">{actions}</div>}
        </div>
      )}
    </div>
  );
}

export function Empty({ icon = "calendar", children }: { icon?: IconName; children: ReactNode }) {
  return (
    <div className="empty card">
      <span className="icon-bubble big">
        <Icon name={icon} size={22} />
      </span>
      <div>{children}</div>
    </div>
  );
}

/** Banestreger som baggrundsgrafik i mørke kort. */
export function Pitch() {
  return (
    <svg className="pitch" viewBox="0 0 400 240" preserveAspectRatio="xMaxYMid slice" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="20" y="20" width="560" height="200" rx="6" />
        <line x1="300" y1="20" x2="300" y2="220" />
        <circle cx="300" cy="120" r="46" />
        <circle cx="300" cy="120" r="3" fill="currentColor" />
        <rect x="20" y="70" width="70" height="100" />
        <rect x="20" y="96" width="26" height="48" />
        <path d="M90 92a34 34 0 0 1 0 56" />
      </g>
    </svg>
  );
}
