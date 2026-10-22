"use client";
import { useEffect } from "react";
import Link from "next/link";

/** Vises, når en side under et hold ikke kan åbnes: fx et modul, foreningen ikke har slået til, eller manglende adgang. */
export default function TeamError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="stack" style={{ maxWidth: 560, margin: "64px auto", padding: "0 16px" }}>
      <h1>Den side kan ikke åbnes</h1>
      <p className="muted">
        Enten er den ikke slået til for holdet, eller også har du ikke adgang. Spørg holdets træner eller foreningens administrator, hvis du mener, den bør være der.
      </p>
      <div className="actions">
        <Link href="/" className="button primary">Til overblikket</Link>
        <button className="button" onClick={reset} type="button">Prøv igen</button>
      </div>
    </main>
  );
}
