import Link from "next/link";
import { headers } from "next/headers";
import { getTeam, listTeamEvents } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { shortDay, time } from "../../../lib/format";
import { Shell, ErrorBox } from "../../../components/Shell";
import { Avatar, AvatarStack, Crest, DateTile, Empty, Icon, PageHead, Stat, TYPE_ICON } from "../../../components/ui";
import { addCoach, newInviteLink, removePlayer } from "../../actions";

export const dynamic = "force-dynamic";
const WEEKS_AHEAD = 6;

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}`);
  const team = await getTeam(db, ctx, id);
  const to = new Date(ctx.now.getTime() + WEEKS_AHEAD * 7 * 86_400_000);
  const events = await listTeamEvents(db, ctx, id, ctx.now, to);
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const playerCount = team.players.length;

  const next = events.find((e) => !e.cancelledAt);

  return (
    <Shell admin={ctx.adminClubs.size > 0}>
      <PageHead
        back={{ href: "/", label: "Overblik" }}
        title={
          <span className="team-hero">
            <Crest name={team.name} size={52} />
            {team.name}
          </span>
        }
        sub={`${team.clubName}${team.season ? ` · ${team.season}` : ""}`}
        actions={
          team.canManage && (
            <>
              <Link href={`/hold/${id}/fremmoede`} className="button">
                <Icon name="chart" size={18} /> Fremmøde
              </Link>
              <Link href={`/hold/${id}/ny`} className="button primary">
                <Icon name="plus" size={18} /> Ny aktivitet
              </Link>
            </>
          )
        }
      />
      <ErrorBox message={fejl} />

      <div className="tiles" style={{ marginBottom: 20 }}>
        <Stat label="Spillere" value={playerCount} icon="users" hint={<AvatarStack names={team.players.map((p) => `${p.firstName} ${p.lastName}`)} max={6} size={28} />} />
        <Stat label="Aktiviteter" value={events.filter((e) => !e.cancelledAt).length} icon="calendar" hint={`de næste ${WEEKS_AHEAD} uger`} />
        <Stat
          label="Næste"
          tone="brand"
          icon={next ? TYPE_ICON[next.type] : "calendar"}
          value={next ? <span style={{ fontSize: 30 }}>{time(next.startsAt)}</span> : "–"}
          hint={next ? <span style={{ color: "var(--on-feature-muted)" }}>{shortDay(next.startsAt)} · {next.yes} kommer</span> : "Intet planlagt"}
        />
      </div>

      <div className="team-layout">
        <section>
          <div className="section-head">
            <h2>Kalender</h2>
          </div>
          {events.length === 0 && <Empty>Ingen aktiviteter de næste {WEEKS_AHEAD} uger.</Empty>}
          <ul className="events">
            {events.map((e) => {
              const none = Math.max(0, playerCount - e.yes - e.maybe - e.no);
              const pct = (n: number) => `${playerCount ? (n / playerCount) * 100 : 0}%`;
              return (
                <li key={e.id}>
                  <Link href={`/aktivitet/${e.id}`} className={e.cancelledAt ? "card row-card cancelled" : "card row-card"}>
                    <DateTile date={e.startsAt} type={e.type} />
                    <span className="grow" style={{ display: "grid", gap: 6 }}>
                      <span>
                        <span className={e.cancelledAt ? "t strike" : "t"}>{e.title}</span>
                        <span className="muted small">
                          {time(e.startsAt)}
                          {e.location ? ` · ${e.location}` : ""}
                          {e.cancelledAt && <span className="cancelled-note"> · Aflyst</span>}
                        </span>
                      </span>
                      {!e.cancelledAt && (
                        <span className="meter" title={`${e.yes} kommer, ${e.maybe} måske, ${e.no} kommer ikke, ${none} ikke svaret`}>
                          <i className="yes" style={{ width: pct(e.yes) }} />
                          <i className="maybe" style={{ width: pct(e.maybe) }} />
                          <i className="no" style={{ width: pct(e.no) }} />
                        </span>
                      )}
                    </span>
                    {!e.cancelledAt && (
                      <span className="counts">
                        <span className="yes">{e.yes}</span>
                        <span className="maybe">{e.maybe}</span>
                        <span className="no">{e.no}</span>
                        <span className="none">{none}</span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
          {!!events.length && (
            <p className="legend">
              <span><i className="yes" />Kommer</span>
              <span><i className="maybe" />Måske</span>
              <span><i className="no" />Kommer ikke</span>
              <span><i className="none" />Ikke svaret</span>
            </p>
          )}
        </section>

        <aside className="dash-side">
          <section>
            <div className="section-head">
              <h2>Trænere</h2>
            </div>
            <ul className="people">
              {team.coaches.map((c) => (
                <li key={c.profileId}>
                  <Avatar name={`${c.firstName} ${c.lastName}`} />
                  <span className="name grow">
                    {c.firstName} {c.lastName}
                  </span>
                  <span className="pill brand">Træner</span>
                </li>
              ))}
              {team.coaches.length === 0 && <li className="muted">Ingen træner endnu</li>}
            </ul>
            {team.canManageCoaches && (
              <details style={{ marginTop: 10 }}>
                <summary>Tilføj træner</summary>
                <form action={addCoach} className="inline">
                  <input type="hidden" name="teamId" value={id} />
                  <input type="email" name="email" required placeholder="Trænerens e-mail" />
                  <button>Tilføj</button>
                </form>
                <p className="muted small" style={{ marginTop: 6 }}>Personen skal have logget ind i HoldLiv én gang.</p>
              </details>
            )}
          </section>

          <section>
            <div className="section-head">
              <h2>Spillere</h2>
              <span className="pill">{playerCount}</span>
            </div>
            <ul className="people">
              {team.players.map((p) => (
                <li key={p.profileId}>
                  <Avatar name={`${p.firstName} ${p.lastName}`} />
                  <span className="grow">
                    <span className="name">
                      {p.firstName} {p.lastName}
                    </span>
                    {p.mine && <span className="muted"> (din)</span>}
                    {p.guardians.length > 0 && (
                      <span className="note">{p.guardians.map((g) => `${g.firstName} ${g.lastName}${g.phone ? `, ${g.phone}` : ""}`).join(" · ")}</span>
                    )}
                  </span>
                  {team.canManage && (
                    <form action={removePlayer}>
                      <input type="hidden" name="teamId" value={id} />
                      <input type="hidden" name="profileId" value={p.profileId} />
                      <button className="link small">Fjern</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {team.inviteCode && (
            <section className="card tint invite">
              <div className="stat-top">
                <strong>Invitér spillere og forældre</strong>
                <span className="icon-bubble">
                  <Icon name="link" size={18} />
                </span>
              </div>
              <p className="small">Del linket i fx holdets Facebook- eller Messenger-gruppe. Forældre logger ind, vælger deres barn og er med på holdet.</p>
              <input readOnly value={`${origin}/join/${team.inviteCode}`} className="mono" style={{ background: "var(--surface)" }} />
              <form action={newInviteLink}>
                <input type="hidden" name="teamId" value={id} />
                <button className="link small" style={{ color: "var(--brand-ink)" }}>
                  Lav et nyt link (det gamle holder op med at virke)
                </button>
              </form>
            </section>
          )}
        </aside>
      </div>
    </Shell>
  );
}
