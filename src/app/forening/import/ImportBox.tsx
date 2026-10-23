"use client";
import { useActionState } from "react";
import Link from "next/link";
import { importAction, type ImportState } from "../../actions";

type Source = "excel" | "klubmodul" | "holdsport";
const SOURCES: Record<Source, { label: string; steps: string[] }> = {
  klubmodul: {
    label: "Klubmodul",
    steps: [
      "Log ind i Klubmodul som administrator og åbn medlemslisten.",
      "Vælg alle medlemmer (også dem med børn), og tag med de kolonner, du vil flytte: navn, fødselsdato, e-mail, telefon, afdeling/hold, forælder og status.",
      "Brug eksport (Excel eller CSV) og gem filen på din computer.",
      "Vælg filen her. Står der en statuskolonne, springer vi udmeldte medlemmer over.",
    ],
  },
  holdsport: {
    label: "Holdsport",
    steps: [
      "Log ind i Holdsport som administrator (klubadmin) og åbn medlemmerne.",
      "Eksportér medlemslisten som CSV eller Excel. Tag holdnavn med, så holdene oprettes i HoldLiv.",
      "Gem filen på din computer og vælg den her.",
      "Er der flere hold i samme fil, skilles de med komma eller lodret streg.",
    ],
  },
  excel: {
    label: "Excel eller anden fil",
    steps: ["Gem listen som CSV (i Excel: Gem som, CSV).", "Første række skal være overskrifter: fornavn, efternavn, fødselsdato, e-mail, telefon, hold og evt. forælder."],
  },
};

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
  ["status", "Status (udmeldte springes over)"],
  ["ignore", "Spring over"],
];

export function ImportBox({ clubId }: { clubId: string }) {
  const [state, action, pending] = useActionState<ImportState, FormData>(importAction, {});
  const { done, counts } = state;
  const source: Source = state.source ?? "klubmodul";
  return (
    <form action={action} className="stack">
      <input type="hidden" name="clubId" value={clubId} />
      {(done || state.headers) && <input type="hidden" name="source" value={source} />}
      {state.error && <p className="error">{state.error}</p>}
      {done ? (
        <div className="card stack">
          <h2 className="section-head">Importen er færdig</h2>
          <p>
            {done.created} nye medlemmer er oprettet, {done.updated} eksisterende er opdateret
            {done.teamsCreated ? `, og ${done.teamsCreated} nye hold er oprettet` : ""}.
          </p>
          <p className="muted small">Næste skridt: send holdenes invitationslink til trænere og forældre, så de kan logge ind, og opret kontingenter med jeres egne priser.</p>
          <p className="row" style={{ gap: 16 }}>
            <Link href={`/forening?klub=${clubId}`}>Til holdene</Link>
            <Link href={`/kasse/kontingenter?klub=${clubId}`}>Opret kontingenter</Link>
            <Link href={`/forening/kom-i-gang?klub=${clubId}`}>Kom i gang-guiden</Link>
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
              {state.inactive ? ` ${state.inactive} udmeldte medlemmer flyttes ikke med.` : ""}
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
          <fieldset className="stack">
            <legend>Hvor flytter I fra?</legend>
            {(Object.keys(SOURCES) as Source[]).map((k) => (
              <details key={k} open={k === "klubmodul"}>
                <summary>
                  <label className="check">
                    <input type="radio" name="source" value={k} defaultChecked={k === "klubmodul"} /> {SOURCES[k].label}
                  </label>
                </summary>
                <ol className="muted small">
                  {SOURCES[k].steps.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ol>
              </details>
            ))}
            <p className="muted small">Menuerne kan hedde noget andet hos udbyderne. Kommer kolonnerne ikke rigtigt med, kan du rette koblingen på næste side, før noget gemmes.</p>
          </fieldset>
          <label>
            CSV-fil
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
