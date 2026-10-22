import { toLocalInput } from "../lib/time";

/** Felterne til at oprette og rette en aktivitet. */
export function EventFields({
  defaults,
}: {
  defaults?: {
    type: string;
    title: string;
    startsAt: Date;
    endsAt: Date | null;
    location: string | null;
    description: string | null;
    responseDeadline: Date | null;
    maxParticipants: number | null;
  };
}) {
  const minutes = defaults?.endsAt ? Math.round((defaults.endsAt.getTime() - defaults.startsAt.getTime()) / 60_000) : 90;
  return (
    <>
      <label>
        Type
        <select name="type" defaultValue={defaults?.type ?? "training"}>
          <option value="training">Træning</option>
          <option value="match">Kamp</option>
          <option value="other">Anden aktivitet</option>
        </select>
      </label>
      <label>
        Titel
        <input name="title" required defaultValue={defaults?.title ?? "Træning"} />
      </label>
      <div className="row">
        <label>
          Starter
          <input type="datetime-local" name="startsAt" required defaultValue={defaults ? toLocalInput(defaults.startsAt) : ""} />
        </label>
        <label>
          Varighed
          <select name="duration" defaultValue={String(minutes)}>
            {[0, 45, 60, 75, 90, 105, 120, 150, 180, 240].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Ikke angivet" : `${Math.floor(m / 60)} t ${m % 60 ? `${m % 60} min` : ""}`.replace("0 t ", "")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Sted
        <input name="location" defaultValue={defaults?.location ?? ""} placeholder="Fx Bane 3" />
      </label>
      <label>
        Beskrivelse <span className="muted">(valgfri)</span>
        <textarea name="description" rows={3} defaultValue={defaults?.description ?? ""} placeholder="Mødetid, påklædning, kørsel" />
      </label>
      <label>
        Svarfrist <span className="muted">(valgfri, ellers til aktiviteten starter)</span>
        <input
          type="datetime-local"
          name="responseDeadline"
          defaultValue={defaults?.responseDeadline ? toLocalInput(defaults.responseDeadline) : ""}
        />
      </label>
      <label>
        Antal pladser <span className="muted">(valgfri, ellers ubegrænset; flere end det kommer på venteliste)</span>
        <input type="number" name="maxParticipants" min={1} max={500} defaultValue={defaults?.maxParticipants ?? ""} placeholder="Fx 12" />
      </label>
    </>
  );
}
