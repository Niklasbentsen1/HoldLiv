import Link from "next/link";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import { logout } from "../app/actions";
import { profiles } from "../db/schema";
import { db } from "../lib/db";
import type { AccessContext } from "../auth/permissions";
import { Avatar, AvatarStack, Icon, Ring, type IconName } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Vises kun, hvis funktionen siger ja. */
  show?: (ctx: AccessContext) => boolean;
}

/** Hovedmenuen. Nye områder (fx Medlemmer, Kontingent) tilføjes her. */
export const NAV: NavItem[] = [
  { href: "/", label: "Overblik", icon: "home" },
  { href: "/familie", label: "Familie", icon: "family" },
  { href: "/betaling", label: "Betaling", icon: "card" },
  { href: "/indstillinger", label: "Beskeder", icon: "bell" },
  { href: "/forening", label: "Forening", icon: "club", show: (ctx) => ctx.adminClubs.size > 0 },
  { href: "/kasse", label: "Kasse", icon: "coins", show: (ctx) => ctx.adminClubs.size > 0 || ctx.treasurerClubs.size > 0 },
];

function Logo() {
  return (
    <Link href="/" className="logo" aria-label="HoldLiv">
      <span className="logo-mark">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path d="M5 4v16M19 4v16M5 12h14" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        </svg>
      </span>
      <span className="logo-word">HoldLiv</span>
    </Link>
  );
}

export async function Shell({ children, ctx, active }: { children: ReactNode; ctx: AccessContext; active?: string }) {
  const [me] = await db.select({ firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(eq(profiles.id, ctx.profileId));
  const name = me ? `${me.firstName} ${me.lastName}` : "";
  const nav = NAV.filter((n) => !n.show || n.show(ctx));

  return (
    <div className="app">
      <aside className="rail">
        <Logo />
        <nav className="rail-nav">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={active === n.href ? "rail-link active" : "rail-link"}>
              <Icon name={n.icon} />
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="rail-foot">
          {me && (
            <div className="rail-me">
              <Avatar name={name} size={36} />
              <span className="grow">
                <strong>{me.firstName}</strong>
                <span className="faint">{me.lastName}</span>
              </span>
            </div>
          )}
          <form action={logout}>
            <button className="rail-link as-button">
              <Icon name="logout" />
              <span>Log ud</span>
            </button>
          </form>
        </div>
      </aside>

      <div className="app-body">
        <header className="topbar">
          <Logo />
          {me && (
            <form action={logout} className="topbar-me">
              <button className="icon-button" title="Log ud" aria-label="Log ud">
                <Icon name="logout" size={18} />
              </button>
              <Avatar name={name} size={36} />
            </form>
          )}
        </header>
        <main className="content">{children}</main>
      </div>

      <nav className="tabbar">
        {nav.map((n) => (
          <Link key={n.href} href={n.href} className={active === n.href ? "tab active" : "tab"}>
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** Til sider uden login: login, kode og velkommen. */
export function Bare({ children }: { children: ReactNode }) {
  return (
    <div className="bare">
      <div className="bare-art" aria-hidden>
        <div className="bare-art-inner">
          <Logo />
          <div className="bare-pitch">
            <svg viewBox="0 0 300 420" preserveAspectRatio="xMidYMid slice">
              <g fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="20" y="20" width="260" height="380" rx="8" />
                <line x1="20" y1="210" x2="280" y2="210" />
                <circle cx="150" cy="210" r="44" />
                <rect x="85" y="20" width="130" height="62" />
                <rect x="85" y="338" width="130" height="62" />
              </g>
            </svg>
          </div>
          <div className="bare-float">
            <div className="float-card one">
              <span className="badge training">Træning · U9 piger</span>
              <strong>Torsdag kl. 17.00</strong>
              <span className="float-row">
                <AvatarStack names={["Alma Juul", "Emma Bentsen", "Freja Møller", "Ida Bak", "Noor Hassan", "Sara Lund", "Ella Dam"]} max={4} size={28} />
                <span>12 kommer</span>
              </span>
            </div>
            <div className="float-card two">
              <Ring value={86} size={70} stroke={9} />
              <span>
                <small>Fremmøde</small>
                <strong>U11 drenge</strong>
              </span>
            </div>
          </div>
          <p className="bare-quote">
            Træning, kampe og fremmøde.
            <br />
            <span>Hele foreningen samlet ét sted.</span>
          </p>
        </div>
      </div>
      <main className="bare-main">
        <div className="bare-mobile-logo">
          <Logo />
        </div>
        {children}
      </main>
    </div>
  );
}

export function ErrorBox({ message }: { message?: string }) {
  return message ? <p className="error">{message}</p> : null;
}
