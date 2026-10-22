"use client";
import { useActionState } from "react";
import { adviceAction } from "../../actions";

export function AdviceBox({ clubId }: { clubId: string }) {
  const [state, action, pending] = useActionState(adviceAction, {});
  return (
    <form action={action} className="card stack">
      <input type="hidden" name="clubId" value={clubId} />
      <h2 className="section-head">Samlet anbefaling</h2>
      <p className="muted small">Rådgiveren læser de sammentalte tal ovenfor og siger, hvad der bør prioriteres. Der sendes kun antal, aldersgrupper og holdnavne, aldrig navne på personer.</p>
      {state.error && <p className="error">{state.error}</p>}
      {state.text && <p style={{ whiteSpace: "pre-wrap" }}>{state.text}</p>}
      <button disabled={pending}>{pending ? "Tænker…" : "Få en anbefaling"}</button>
    </form>
  );
}
