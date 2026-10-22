import Link from "next/link";
import { loadActingProfiles } from "../auth/context";
import { listMyTeams, listUpcomingEvents } from "../services";
import { db } from "../lib/db";
import { requireSession } from "../lib/session";
import { dayHeading, time, TYPE_LABEL } from "../lib/format";
import { Shell } from "../components/Shell";
import { RespondForm } from "../components/RespondForm";
import { switchProfile } from "./actions";

export const dynamic = "force-dynamic";
const WEEKS_AHEAD = 2;

export default async function Home({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx, actingProfileId } = await requireSession();
  const acting = await loadActingProfiles(db, ctx);
  const shown = actingProfileId ? acting.filter((p) => p.id === actingProfileId) : acting;
  const to = new Date(ctx.now.getTime() + WEEKS_AHEAD * 7 * 86_400_000);

  const [teams, perPerson] = await Promise.all([
    listMyTeams(db, ctx),
    Promise.all(shown.map(async (p) => (await listUpcomingEvents(db, ctx, p.id, ctx.now, to)).map((e) => ({ ...e, person: p })))),
  ]);
  const items = perPerson.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const byDay = new Map<string, typeof items>();
  for (const e of items) {
    const k = dayHeading(e.startsAt);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const many = acting.length > 1;

  return (
    <Shell active="/" admin={ctx.adminClubs.size > 0}>
      {fejl && <p className="error">{fejl}</p>}
      {many && (
        <div className="chips sticky">
          {[{ id: "all", firstName: "Hele familien", isSelf: false }, ...acting].map((p) => {
            const on = p.id === (actingProfileId ?? "all");
            return (
              <form key={p.id} action={switchProfile}>
                <input type="hidden" name="profileId" value={p.id} />
                <button className={on ? "chip active" : "chip"}>
                  {p.firstName}
                  {p.isSelf ? " (mig)" : ""}
                </button>
              </form>
            );
          })}
        </div>
      )}

      <h2>Kommende {WEEKS_AHEAD} uger</h2>
      {items.length === 0 && (
        <p className="muted">
          Ingen aktiviteter. Har du fået et invitationslink fra træneren, så åbn det for at komme på holdet.
        </p>
      )}
      {[...byDay].map(([dayLabel, list]) => (
        <section key={dayLabel}>
          <h3 className="day">{dayLabel}</h3>
          <ul className="events">
            {list.map((e) => {
              const closesAt = e.responseDeadline ?? e.startsAt;
              const closed = !!e.cancelledAt || ctx.now >= closesAt;
              return (
                <li key={`${e.id}-${e.person.id}`} className={e.cancelledAt ? "card cancelled" : "card"}>
                  <div className="meta">
                    <span className={`tag ${e.type}`}>{TYPE_LABEL[e.type]}</span> {e.teamName}
                    {many && <span className="who">{e.person.firstName}</span>}
                  </div>
                  <Link href={`/aktivitet/${e.id}`} className="title">
                    {e.title}
                  </Link>
                  <div className="muted">
                    {time(e.startsAt)}
                    {e.endsAt ? `–${time(e.endsAt)}` : ""}
                    {e.location ? ` · ${e.location}` : ""}
                  </div>
                  {e.cancelledAt ? (
                    <p className="cancelled-note">Aflyst</p>
                  ) : (
                    <>
                      {e.responseDeadline && !closed && (
                        <p className="muted small">
                          Svar senest {dayHeading(e.responseDeadline).toLowerCase()} kl. {time(e.responseDeadline)}
                        </p>
                      )}
                      <RespondForm
                        eventId={e.id}
                        profileId={e.person.id}
                        status={e.status}
                        comment={e.comment}
                        back="/"
                        disabled={closed}
                      />
                      {closed && <p className="muted small">Fristen er overskredet. Kontakt træneren for at ændre svaret.</p>}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <h2>Hold</h2>
      {teams.length === 0 && <p className="muted">Du er ikke på nogen hold endnu.</p>}
      <ul className="teams">
        {teams.map((t) => (
          <li key={t.id}>
            <Link href={`/hold/${t.id}`} className="card team-link">
              <strong>{t.name}</strong>
              <span className="muted small">
                {t.clubName}
                {t.season ? ` · ${t.season}` : ""}
              </span>
              <span className="labels">{t.labels.join(" · ")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
