"use client";
import { useActionState } from "react";
import { memberServiceAction } from "../actions";

export function HelpBox() {
  const [state, action, pending] = useActionState(memberServiceAction, {});
  return (
    <form action={action} className="card stack">
      <label>
        Dit spørgsmål
        <textarea name="question" required maxLength={500} rows={3} placeholder="Fx: Hvornår er næste træning? Hvad mangler jeg at betale?" />
      </label>
      <p className="muted small">Skriv ikke andres navne eller private oplysninger. Hjælpen kan ikke melde af, betale eller ændre noget.</p>
      {state.error && <p className="error">{state.error}</p>}
      {state.text && <p style={{ whiteSpace: "pre-wrap" }}>{state.text}</p>}
      <button className="primary" disabled={pending}>{pending ? "Tænker…" : "Spørg"}</button>
    </form>
  );
}
