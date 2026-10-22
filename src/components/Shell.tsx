import Link from "next/link";
import type { ReactNode } from "react";
import { logout } from "../app/actions";

export function Shell({ children, admin, active }: { children: ReactNode; admin?: boolean; active?: string }) {
  const nav = [
    { href: "/", label: "Kalender" },
    { href: "/familie", label: "Familie" },
    ...(admin ? [{ href: "/forening", label: "Forening" }] : []),
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
