"use client";
import { useActionState, useState } from "react";
import { beginMfaAction, confirmMfaAction, disableMfaAction, regenerateCodesAction, type MfaState } from "../../actions";

const none: MfaState = {};

function Codes({ codes }: { codes: string[] }) {
  return (
    <div className="stack">
      <p>Gem nødkoderne et sikkert sted. Hver kan bruges én gang, og de vises kun nu.</p>
      <ul className="stack" style={{ fontFamily: "monospace", listStyle: "none", padding: 0 }}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export function MfaSetup({ enabled, required, recoveryLeft }: { enabled: boolean; required: boolean; recoveryLeft: number }) {
  const [begin, setBegin] = useState<MfaState>(none);
  const [confirm, confirmAction, confirming] = useActionState(confirmMfaAction, none);
  const [disable, disableAction, disabling] = useActionState(disableMfaAction, none);
  const [regen, regenAction, regenerating] = useActionState(regenerateCodesAction, none);

  if (confirm.codes) {
    return (
      <section className="card stack">
        <h2 className="section-head">To-faktor er slået til</h2>
        <Codes codes={confirm.codes} />
        <a className="button primary" href="/">Færdig</a>
      </section>
    );
  }
  if (disable.done) return <section className="card stack"><p>To-faktor er slået fra.</p></section>;

  if (enabled) {
    return (
      <>
        <section className="card stack" style={{ marginBottom: 20 }}>
          <h2 className="section-head">Slået til</h2>
          <p className="muted">Du har {recoveryLeft} nødkoder tilbage.</p>
          {regen.codes ? (
            <Codes codes={regen.codes} />
          ) : (
            <form action={regenAction} className="stack">
              {regen.error && <p className="error">{regen.error}</p>}
              <label>
                Kode fra appen
                <input name="code" required autoComplete="one-time-code" placeholder="123456" />
              </label>
              <button disabled={regenerating}>Lav nye nødkoder</button>
            </form>
          )}
        </section>
        {!required && (
          <form action={disableAction} className="card stack">
            <h2 className="section-head">Slå fra</h2>
            {disable.error && <p className="error">{disable.error}</p>}
            <label>
              Kode fra appen
              <input name="code" required autoComplete="one-time-code" placeholder="123456" />
            </label>
            <button disabled={disabling}>Slå to-faktor fra</button>
          </form>
        )}
      </>
    );
  }

  return (
    <section className="card stack">
      {!begin.secret ? (
        <>
          <p>Du skal bruge en autentificeringsapp, fx Google Authenticator, Microsoft Authenticator eller 1Password.</p>
          {begin.error && <p className="error">{begin.error}</p>}
          <button className="primary" onClick={async () => setBegin(await beginMfaAction())}>Start opsætning</button>
        </>
      ) : (
        <form action={confirmAction} className="stack">
          <p>
            Tilføj en ny konto i appen med denne nøgle: <code style={{ wordBreak: "break-all" }}>{begin.secret}</code>
          </p>
          <p className="muted small">
            Åbner du dette på telefonen, kan du i stedet <a href={begin.uri}>tilføje den direkte</a>.
          </p>
          {confirm.error && <p className="error">{confirm.error}</p>}
          <label>
            Skriv koden, appen viser
            <input name="code" required autoComplete="one-time-code" placeholder="123456" className="code" />
          </label>
          <button className="primary" disabled={confirming}>Bekræft og slå til</button>
        </form>
      )}
    </section>
  );
}
