"use client";
import Link from "next/link";
import { useActionState } from "react";
import type { BuyTicketsState } from "../../actions";

export function BuyForm({ maxPerOrder, remaining, priceLabel, action }: { maxPerOrder: number; remaining: number | null; priceLabel: string; action: (s: BuyTicketsState, f: FormData) => Promise<BuyTicketsState> }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  const max = Math.max(1, Math.min(maxPerOrder, remaining ?? maxPerOrder));
  return (
    <form action={formAction} className="card stack">
      <h2 className="section-head">Køb billetter</h2>
      {state.error && <p className="error">{state.error}</p>}
      <label>
        Antal billetter ({priceLabel} pr. stk.)
        <input type="number" name="quantity" min={1} max={max} defaultValue={v.quantity ?? 1} required />
      </label>
      <label>
        Dit navn
        <input name="name" required maxLength={120} defaultValue={v.name} autoComplete="name" />
      </label>
      <label>
        E-mail <span className="muted">(her sender vi billetterne)</span>
        <input type="email" name="email" required defaultValue={v.email} autoComplete="email" />
      </label>
      <div aria-hidden style={{ position: "absolute", left: "-9999px" }}>
        <label>
          Lad feltet stå tomt
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" name="acceptTerms" required /> Jeg accepterer, at foreningen gemmer mit navn og min e-mail til billetterne. Se <Link href="/privatliv">privatlivspolitikken</Link>.
      </label>
      <button className="primary" disabled={pending}>
        {pending ? "Et øjeblik…" : "Gå til betaling"}
      </button>
    </form>
  );
}
