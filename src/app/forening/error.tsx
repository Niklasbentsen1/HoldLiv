"use client";
import Link from "next/link";

export default function ForeningError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="card stack" style={{ maxWidth: 480, margin: "48px auto" }}>
      <h1>Noget gik galt</h1>
      <p className="muted">Siden kunne ikke vises. Du har måske ikke adgang til foreningen, eller også er der opstået en fejl hos os.</p>
      <div className="inline">
        <button onClick={reset}>Prøv igen</button>
        <Link href="/" className="button">Til overblikket</Link>
      </div>
    </main>
  );
}
