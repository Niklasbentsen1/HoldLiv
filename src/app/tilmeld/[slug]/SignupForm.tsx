"use client";
import Link from "next/link";
import { useActionState } from "react";
import type { SignupState } from "../../actions";

interface Info {
  clubName: string;
  minAge: number | null;
  maxAge: number | null;
  terms: string | null;
  teams: { id: string; name: string; season: string | null }[];
}

export function SignupForm({ info, action }: { info: Info; action: (s: SignupState, f: FormData) => Promise<SignupState> }) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = state.values ?? {};
  if (state.done)
    return (
      <section className="card stack">
        <h1>Tak for din ansøgning</h1>
        <p>{info.clubName} har fået den og skriver til dig på e-mail, når den er behandlet.</p>
      </section>
    );
  const ages = [info.minAge !== null ? `fra ${info.minAge} år` : null, info.maxAge !== null ? `til og med ${info.maxAge} år` : null].filter(Boolean).join(" ");
  return (
    <form action={formAction} className="card stack">
      <h1>Meld dig ind i {info.clubName}</h1>
      <p className="muted small">Foreningen læser din ansøgning og godkender den. {ages && `Indmeldelsen er ${ages}.`}</p>
      {state.error && <p className="error">{state.error}</p>}
      <div className="row">
        <label>
          Fornavn
          <input name="firstName" required defaultValue={v.firstName} autoComplete="given-name" />
        </label>
        <label>
          Efternavn
          <input name="lastName" required defaultValue={v.lastName} autoComplete="family-name" />
        </label>
      </div>
      <label>
        Fødselsdato
        <input name="birthDate" required placeholder="dd-mm-åååå" defaultValue={v.birthDate} inputMode="numeric" />
      </label>
      <label>
        E-mail <span className="muted">(er den, du melder ind, under 18 år, skriv forælderens)</span>
        <input type="email" name="email" required defaultValue={v.email} autoComplete="email" />
      </label>
      <label>
        Telefon
        <input name="phone" defaultValue={v.phone} autoComplete="tel" />
      </label>
      <label>
        Forælder eller værge <span className="muted">(kun hvis den, der meldes ind, er under 18 år)</span>
        <input name="guardianName" placeholder="For- og efternavn" defaultValue={v.guardianName} />
      </label>
      {info.teams.length > 0 && (
        <label>
          Hold <span className="muted">(valgfrit)</span>
          <select name="teamId" defaultValue={v.teamId ?? ""}>
            <option value="">Ved ikke endnu</option>
            {info.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.season ? ` (${t.season})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Besked til foreningen <span className="muted">(valgfrit)</span>
        <textarea name="message" rows={3} maxLength={1000} defaultValue={v.message} />
      </label>
      {info.terms && (
        <details open>
          <summary>Foreningens betingelser</summary>
          <p style={{ whiteSpace: "pre-wrap" }} className="small">
            {info.terms}
          </p>
        </details>
      )}
      <label className="check">
        <input type="checkbox" name="acceptTerms" required defaultChecked={v.acceptTerms === "on"} />
        Jeg accepterer {info.terms ? "foreningens betingelser og " : ""}
        <Link href="/privatliv" target="_blank">
          privatlivspolitikken
        </Link>
      </label>
      {/* Skjult felt, som kun robotter udfylder. */}
      <div aria-hidden style={{ position: "absolute", left: "-10000px" }}>
        <input name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button className="primary" disabled={pending}>
        {pending ? "Sender…" : "Send ansøgning"}
      </button>
    </form>
  );
}
