import Link from "next/link";
import { loadActingProfiles } from "../auth/context";
import { getAttendanceOverview, getEventDetail, listMyTeams, listUpcomingEvents } from "../services";
import { db } from "../lib/db";
import { requireSession } from "../lib/session";
import { day, dayHeading, time } from "../lib/format";
import { TIME_ZONE } from "../lib/time";
import { Shell } from "../components/Shell";
import { RespondForm } from "../components/RespondForm";
import { Avatar, AvatarStack, Bars, Crest, DateTile, Empty, Icon, Pitch, Ring, Stat, TypeBadge } from "../components/ui";
import { switchProfile } from "./actions";

export const dynamic = "force-dynamic";
const WEEKS_AHEAD = 2;
const DAY = 86_400_000;

const dateKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(d);
const weekdayShort = (d: Date) => new Intl.DateTimeFormat("da-DK", { timeZone: TIME_ZONE, weekday: "short" }).format(d).replace(".", "");
const dayNumber = (d: Date) => new Intl.DateTimeFormat("da-DK", { timeZone: TIME_ZONE, day: "numeric" }).format(d).replace(".", "");
const hourNow = (d: Date) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", hour12: false }).format(d));

function greeting(now: Date) {
  const h = hourNow(now);
  return h < 5 ? "God nat" : h < 10 ? "God morgen" : h < 12 ? "God formiddag" : h < 18 ? "God eftermiddag" : "God aften";
}

/** "om 2 dage", nedtælling i dage, timer og minutter. */
function countdown(from: Date, to: Date) {
  const ms = Math.max(0, to.getTime() - from.getTime());
  return { d: Math.floor(ms / DAY), h: Math.floor((ms % DAY) / 3_600_000), m: Math.floor((ms % 3_600_000) / 60_000) };
}

export default async function Home({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx, actingProfileId } = await requireSession();
  const acting = await loadActingProfiles(db, ctx);
  const me = acting.find((p) => p.isSelf)!;
  const shown = actingProfileId ? acting.filter((p) => p.id === actingProfileId) : acting;
  const to = new Date(ctx.now.getTime() + WEEKS_AHEAD * 7 * DAY);
  const attendanceFrom = new Date(ctx.now.getTime() - 28 * DAY);

  const [teams, perPerson, coached] = await Promise.all([
    listMyTeams(db, ctx),
    Promise.all(shown.map(async (p) => (await listUpcomingEvents(db, ctx, p.id, ctx.now, to)).map((e) => ({ ...e, person: p })))),
    Promise.all(
      [...ctx.coachTeams].map(async (teamId) => {
        const o = await getAttendanceOverview(db, ctx, teamId, attendanceFrom, to);
        const rates = o.players.map((p) => p.rate).filter((r): r is number => r !== null);
        return {
          teamId,
          rate: rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null,
          missing: o.players.filter((p) => p.unanswered > 0).length,
          players: o.players.length,
        };
      }),
    ),
  ]);
  const items = perPerson.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const isOpen = (e: (typeof items)[number]) => !e.cancelledAt && ctx.now < (e.responseDeadline ?? e.startsAt);
  const many = acting.length > 1;

  // Næste aktivitet får det store kort; resten vises som liste.
  const next = items.find((e) => !e.cancelledAt);
  const nextDetail = next ? await getEventDetail(db, ctx, next.id) : null;
  const rest = items.filter((e) => e !== next);
  const byDay = new Map<string, typeof items>();
  for (const e of rest) {
    const k = dayHeading(e.startsAt);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  // Tal til felterne øverst.
  const unanswered = items.filter((e) => isOpen(e) && !e.status).length;
  const answeredShare = items.filter(isOpen).length ? Math.round((items.filter((e) => isOpen(e) && e.status).length / items.filter(isOpen).length) * 100) : null;
  const week = Array.from({ length: 7 }, (_, i) => new Date(ctx.now.getTime() + i * DAY));
  const perDay = week.map((d) => items.filter((e) => !e.cancelledAt && dateKey(e.startsAt) === dateKey(d)));
  const weekCount = new Set(perDay.flat().map((e) => e.id)).size;
  const coachRates = coached.map((c) => c.rate).filter((r): r is number => r !== null);
  const coachRate = coachRates.length ? Math.round(coachRates.reduce((a, b) => a + b, 0) / coachRates.length) : null;
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const cd = next ? countdown(ctx.now, next.startsAt) : null;

  return (
    <Shell active="/" admin={ctx.adminClubs.size > 0}>
      <div className="greeting">
        <div>
          <p className="today">{day(ctx.now)}</p>
          <h1>
            {greeting(ctx.now)}, {me.firstName}
          </h1>
        </div>
      </div>

      {fejl && <p className="error">{fejl}</p>}
      {many && (
        <div className="switcher">
          {[{ id: "all", firstName: "Hele familien", lastName: "", isSelf: false }, ...acting].map((p) => {
            const on = p.id === (actingProfileId ?? "all");
            return (
              <form key={p.id} action={switchProfile}>
                <input type="hidden" name="profileId" value={p.id} />
                <button className={on ? "chip active" : "chip"}>
                  {p.id === "all" ? (
                    <span className="icon-bubble" style={{ width: 28, height: 28 }}>
                      <Icon name="family" size={16} />
                    </span>
                  ) : (
                    <Avatar name={`${p.firstName} ${p.lastName}`} size={28} />
                  )}
                  {p.firstName}
                  {p.isSelf ? " (mig)" : ""}
                </button>
              </form>
            );
          })}
        </div>
      )}

      <div className="dash">
        <div className="dash-main">
          {next && nextDetail && cd ? (
            <section className="hero">
              <Pitch />
              <div className="hero-top">
                <span className="hero-eyebrow">Næste aktivitet{many ? ` · ${next.person.firstName}` : ""}</span>
                <TypeBadge type={next.type} />
              </div>
              <div>
                <h2>
                  <Link href={`/aktivitet/${next.id}`}>{next.title}</Link>
                </h2>
                <div className="hero-meta" style={{ marginTop: 10 }}>
                  <span>
                    <Icon name="users" size={16} /> {next.teamName}
                  </span>
                  <span>
                    <Icon name="calendar" size={16} /> {dayHeading(next.startsAt)}
                  </span>
                  <span>
                    <Icon name="clock" size={16} /> {time(next.startsAt)}
                    {next.endsAt ? `–${time(next.endsAt)}` : ""}
                  </span>
                  {next.location && (
                    <span>
                      <Icon name="pin" size={16} /> {next.location}
                    </span>
                  )}
                </div>
              </div>
              <div className="hero-foot">
                <div className="countdown" aria-label="Tid til start">
                  <span>
                    <strong>{cd.d}</strong>
                    <small>dage</small>
                  </span>
                  <span>
                    <strong>{cd.h}</strong>
                    <small>timer</small>
                  </span>
                  <span>
                    <strong>{cd.m}</strong>
                    <small>min</small>
                  </span>
                </div>
                <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
                  <AvatarStack names={nextDetail.groups.yes.map((p) => p.name)} />
                  <span className="small muted">
                    {nextDetail.groups.yes.length} af {nextDetail.players.length} kommer
                  </span>
                </div>
              </div>
              <RespondForm eventId={next.id} profileId={next.person.id} status={next.status} comment={next.comment} back="/" disabled={!isOpen(next)} />
            </section>
          ) : (
            <Empty>Ingen aktiviteter de næste {WEEKS_AHEAD} uger. Har du fået et invitationslink fra træneren, så åbn det for at komme på holdet.</Empty>
          )}

          <div className="tiles">
            <Stat label="Mangler dit svar" value={unanswered} icon="bell" tone={unanswered ? "volt" : undefined} hint={unanswered ? "Svar, så træneren kan planlægge" : "Du har svaret på alt"} />
            <Stat label="Næste 7 dage" value={weekCount} icon="calendar" hint={weekCount === 1 ? "aktivitet" : "aktiviteter"}>
              <Bars values={perDay.map((l) => l.length)} labels={week.map((d) => weekdayShort(d).slice(0, 2))} highlight={0} />
            </Stat>
            {coachRate !== null ? (
              <Stat label="Fremmøde, 4 uger" value={<Ring value={coachRate} size={92} stroke={10} />} icon="chart" hint="Snit på dine hold" />
            ) : (
              <Stat label="Besvaret" value={<Ring value={answeredShare} size={92} stroke={10} tone="yes" />} icon="check" hint="Af de åbne aktiviteter" />
            )}
          </div>

          <section className="card">
            <div className="section-head">
              <h2>Ugen</h2>
            </div>
            <div className="week">
              {week.map((d, i) => (
                <div key={i} className={i === 0 ? "wd today" : "wd"}>
                  <span className="l">{weekdayShort(d)}</span>
                  <span className="n">{dayNumber(d)}</span>
                  <span className="dots">
                    {perDay[i].slice(0, 3).map((e) => (
                      <i key={`${e.id}-${e.person.id}`} className={e.type} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="upcoming">
            <div className="section-head">
              <h2>Kommende {WEEKS_AHEAD} uger</h2>
            </div>
            {rest.length === 0 && <p className="muted">Ikke flere aktiviteter i perioden.</p>}
            {[...byDay].map(([dayLabel, list]) => (
              <div key={dayLabel}>
                <h3 className="day-label">{dayLabel}</h3>
                <ul className="events">
                  {list.map((e) => {
                    const closed = !isOpen(e);
                    return (
                      <li key={`${e.id}-${e.person.id}`} className={e.cancelledAt ? "card event cancelled" : "card event"}>
                        <DateTile date={e.startsAt} type={e.type} />
                        <div>
                          <div className="event-top">
                            <TypeBadge type={e.type} />
                            {e.cancelledAt && <span className="pill cancel">Aflyst</span>}
                            {many && (
                              <span className="who">
                                <Avatar name={`${e.person.firstName} ${e.person.lastName}`} size={22} />
                                {e.person.firstName}
                              </span>
                            )}
                          </div>
                          <Link href={`/aktivitet/${e.id}`} className={e.cancelledAt ? "title strike" : "title"}>
                            {e.title}
                          </Link>
                          <div className="info">
                            <span>
                              <Icon name="clock" size={15} />
                              {time(e.startsAt)}
                              {e.endsAt ? `–${time(e.endsAt)}` : ""}
                            </span>
                            <span>
                              <Icon name="users" size={15} />
                              {e.teamName}
                            </span>
                            {e.location && (
                              <span>
                                <Icon name="pin" size={15} />
                                {e.location}
                              </span>
                            )}
                          </div>
                          {e.responseDeadline && !closed && !e.cancelledAt && (
                            <p className="small muted" style={{ marginTop: 8 }}>
                              Svar senest {dayHeading(e.responseDeadline).toLowerCase()} kl. {time(e.responseDeadline)}
                            </p>
                          )}
                        </div>
                        {!e.cancelledAt && (
                          <div className="event-respond">
                            <RespondForm eventId={e.id} profileId={e.person.id} status={e.status} comment={e.comment} back="/" disabled={closed} />
                            {closed && <p className="small muted" style={{ marginTop: 8 }}>Fristen er overskredet. Kontakt træneren for at ændre svaret.</p>}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        </div>

        <aside className="dash-side">
          {coached.length > 0 && (
            <section className="card ink stack">
              <div className="section-head" style={{ marginBottom: 0 }}>
                <h2>Dine hold som træner</h2>
              </div>
              {coached.map((c) => (
                <Link key={c.teamId} href={`/hold/${c.teamId}/fremmoede`} className="coach-card" style={{ textDecoration: "none" }}>
                  <Ring value={c.rate} size={58} stroke={7} />
                  <span className="grow">
                    <strong className="block">{teamName.get(c.teamId)}</strong>
                    <span className="small" style={{ color: "var(--on-ink-muted)" }}>
                      {c.missing ? `${c.missing} af ${c.players} mangler at svare` : `${c.players} spillere, alle har svaret`}
                    </span>
                  </span>
                  <Icon name="arrow" size={18} />
                </Link>
              ))}
            </section>
          )}

          <section>
            <div className="section-head">
              <h2>Hold</h2>
            </div>
            {teams.length === 0 && <p className="muted">Du er ikke på nogen hold endnu.</p>}
            <ul className="teams">
              {teams.map((t) => (
                <li key={t.id}>
                  <Link href={`/hold/${t.id}`} className="card team-card">
                    <Crest name={t.name} size={40} />
                    <span className="grow">
                      <strong className="block">{t.name}</strong>
                      <span className="labels">{t.labels.join(" · ")}</span>
                    </span>
                    <span className="go">
                      <Icon name="arrow" size={16} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
