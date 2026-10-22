import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "../app/actions";
import type { AccessContext } from "../auth/permissions";

export function Shell({ children, ctx, active }: { children: ReactNode; ctx: AccessContext; active?: string }) {
  const nav = [
    { href: "/", label: "Kalender" },
    { href: "/familie", label: "Familie" },
    { href: "/betaling", label: "Betaling" },
    ...(ctx.adminClubs.size ? [{ href: "/forening", label: "Forening" }] : []),
    ...(ctx.adminClubs.size || ctx.treasurerClubs.size ? [{ href: "/kasse", label: "Kasse" }] : []),
  ];
  return (
    <main>
      <header>
        <Link href="/" className="logo">
          HoldLiv
        </Link>
        <nav>
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className={active === n.href ? "active" : undefined}>
              {n.label}
            </Link>
          ))}
          <form action={logout}>
            <button className="link">Log ud</button>
          </form>
        </nav>
      </header>
      {children}
    </main>
  );
}

export function Bare({ children }: { children: ReactNode }) {
  return (
    <main>
      <header>
        <span className="logo">HoldLiv</span>
      </header>
      {children}
    </main>
  );
}

export function ErrorBox({ message }: { message?: string }) {
  return message ? <p className="error">{message}</p> : null;
}
