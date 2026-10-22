"use client";
import { useActionState } from "react";
import { importAction, type ImportState } from "../../actions";

const TARGET_OPTIONS: [string, string][] = [
  ["firstName", "Fornavn"],
  ["lastName", "Efternavn"],
  ["fullName", "Navn (samlet)"],
  ["birthDate", "Fødselsdato"],
  ["email", "E-mail"],
  ["phone", "Telefon"],
  ["team", "Hold / afdeling"],
  ["guardianName", "Forælder: navn"],
  ["guardianEmail", "Forælder: e-mail"],
  ["guardianPhone", "Forælder: telefon"],
  ["custom", "Eget felt (bevar kolonnen)"],
  ["ignore", "Spring over"],
];

export function ImportBox({ clubId }: { clubId: string }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importAction, {});
  const { done, counts } = state;
  return (
    <form action={action} className="stack">
      <input type="hidden" name="clubId" value={clubId} />
      {state.error && <p className="error">{state.error}</p>}
      {done ? (
        <div className="card stack">
          <h2 className="section-head">Importen er færdig</h2>
          <p>
            {done.created} nye medlemmer er oprettet, {done.updated} eksisterende er opdateret
            {done.teamsCreated ? `, og ${done.teamsCreated} nye hold er oprettet` : ""}.
          </p>
        </div>
      ) : state.headers && counts ? (
        <>
          <input type="hidden" name="text" value={state.text} />
          <input type="hidden" name="headerCount" value={state.headers.length} />
          <input type="hidden" name="headers" value={JSON.stringify(state.headers)} />
          <div className="card stack">
            <h2 className="section-head">Kolonner</h2>
            <p className="muted small">Tjek, at HoldLiv har forstået kolonnerne. Ret, hvis noget er forkert.</p>
            {state.headers.map((h, i) => (
              <label key={i}>
                {h || "(uden overskrift)"}
                <select name={`map-${i}`} defaultValue={state.mapping![i].target}>
                  {TARGET_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            ))}
            <button name="intent" value="preview" disabled={pending}>Opdatér visningen</button>
          </div>
          <div className="card stack">
            <h2 className="section-head">Det vil ske</h2>
            <p>
              {counts.new} nye, {counts.existing} findes allerede (udfyldes kun, hvis noget mangler), {counts.duplicate} dubletter springes over
              {counts.error ? `, ${counts.error} med fejl` : ""}.
            </p>
            {!!state.newTeams?.length && <p>Nye hold oprettes: {state.newTeams.join(", ")}.</p>}
            {!!state.sample?.length && (
              <ul className="stack">
                {state.sample.map((r) => (
                  <li key={r.line}>
                    <strong>Række {r.line}: {r.name}</strong> <span className="pill">{r.status}</span>
                    {r.notes.map((n) => (
                      <span key={n} className="muted small block">{n}</span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <button name="intent" value="commit" disabled={pending || counts.error > 0 || counts.new + counts.existing === 0}>
              {pending ? "Importerer…" : `Importér ${counts.new + counts.existing} medlemmer`}
            </button>
            {counts.error > 0 && <p className="muted small">Ret fejlene i filen og vælg den igen, før du kan importere.</p>}
            <a href="" className="muted small">Start forfra med en anden fil</a>
          </div>
        </>
      ) : (
        <div className="card stack">
          <label>
            CSV-fil (fra Excel, Klubmodul eller Holdsport)
            <input type="file" name="file" accept=".csv,.txt,text/csv" />
          </label>
          <label>
            …eller indsæt medlemmerne her
            <textarea name="text" rows={6} placeholder={"Fornavn;Efternavn;Fødselsdato;E-mail;Hold\nAnna;Hansen;12-03-2015;mor@eksempel.dk;U9"} />
          </label>
          <button name="intent" value="preview" disabled={pending}>{pending ? "Læser…" : "Se, hvad der vil ske"}</button>
        </div>
      )}
    </form>
  );
}
