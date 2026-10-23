import Link from "next/link";
import type { ReactNode } from "react";

/** Fælles ramme om de åbne salgssider: ingen login, ingen app-menu. */
export function SalesFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "24px 16px 64px" }}>
      <header className="sales-head">
        <Link href="/for-foreninger" className="logo" aria-label="HoldLiv"><span className="logo-word">HoldLiv</span></Link>
        <nav className="sales-nav" aria-label="Hovedmenu">
          <Link href="/for-foreninger" className="muted">Forside</Link>
          <Link href="/priser" className="muted">Pris og sammenligning</Link>
          <Link href="/hjaelpecenter" className="muted">Hjælp</Link>
        </nav>
        <Link href="/login">Log ind</Link>
        <Link href="/login?next=/opret-forening" className="primary">Opret forening</Link>
      </header>
      <main className="stack">{children}</main>
      <footer className="muted small" style={{ marginTop: 48 }}>
        <Link href="/privatliv">Privatlivspolitik</Link> · <Link href="/hjaelpecenter/kontakt">Kontakt</Link>
      </footer>
    </div>
  );
}
