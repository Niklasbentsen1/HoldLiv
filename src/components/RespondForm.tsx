import { STATUSES, STATUS_LABEL } from "../lib/format";
import { respond } from "../app/actions";
import { Icon } from "./ui";

const ICON = { yes: "check", maybe: null, no: "x" } as const;

/** Kommer / Måske / Kommer ikke, med en valgfri besked til træneren. */
export function RespondForm({
  eventId,
  profileId,
  status,
  comment,
  back,
  disabled,
  waitlistPosition,
  name,
}: {
  eventId: string;
  profileId: string;
  status: string | null;
  comment?: string | null;
  back: string;
  disabled?: boolean;
  /** Placering på ventelisten, hvis svaret er "kommer", men pladserne er fyldt. */
  waitlistPosition?: number | null;
  /** Hvem svaret gælder, til teksten om ventelisten. */
  name?: string;
}) {
  return (
    <form action={respond} className="respond">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="profileId" value={profileId} />
      <input type="hidden" name="back" value={back} />
      <div className="answers">
        {STATUSES.map((s) => (
          <button key={s} name="status" value={s} disabled={disabled} className={status === s ? `answer ${s} active` : "answer"}>
            {ICON[s] && status === s && <Icon name={ICON[s]} size={16} />}
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      {waitlistPosition ? <p className="muted small">Pladserne er fyldt. {name ?? "Du"} står som nr. {waitlistPosition} på ventelisten og får besked, hvis der bliver en plads.</p> : null}
      {!disabled && (
        <details className="comment" open={!!comment}>
          <summary>{comment ? `Besked: ${comment}` : "Skriv besked til træneren"}</summary>
          <input name="comment" defaultValue={comment ?? ""} placeholder="Fx syg, kommer senere" maxLength={200} />
          <p className="muted small">Beskeden sendes med, når du trykker på et af svarene.</p>
        </details>
      )}
    </form>
  );
}
