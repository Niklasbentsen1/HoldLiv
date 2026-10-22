import Link from "next/link";
import { headers } from "next/headers";
import { getTeam, listEnabledModules, listTeamEvents } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { shortDay, time, TYPE_LABEL } from "../../../lib/format";
import { Shell, ErrorBox } from "../../../components/Shell";
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
  const modules = await listEnabledModules(db, ctx, id);
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  const playerCount = team.players.length;

  return (
    <Shell ctx={ctx}>
      <h1>{team.name}</h1>
      <p className="muted">
        {team.clubName}
        {team.season ? ` · ${team.season}` : ""} · {playerCount} spillere
      </p>
      <ErrorBox message={fejl} />

      {(team.canManage || modules.length > 0) && (
        <div className="actions">
          {modules.map((m) => (
            <Link key={m.key} href={`/hold/${id}/${m.path}`} className="button">
              {m.name}
            </Link>
          ))}
          {team.canManage && (
            <Link href={`/hold/${id}/moduler`} className="button">
              Moduler
            </Link>
          )}
        </div>
      )}

      {team.canManage && (
        <div className="actions">
          <Link href={`/hold/${id}/ny`} className="button primary">
            Ny aktivitet
          </Link>
          <Link href={`/hold/${id}/fremmoede`} className="button">
            Fremmøde
          </Link>
        </div>
      )}

      <h2>Kalender</h2>
      {events.length === 0 && <p className="muted">Ingen aktiviteter de næste {WEEKS_AHEAD} uger.</p>}
      <ul className="events compact">
        {events.map((e) => (
          <li key={e.id}>
            <Link href={`/aktivitet/${e.id}`} className={e.cancelledAt ? "card row-card cancelled" : "card row-card"}>
              <span className="date">
                <span>{shortDay(e.startsAt)}</span>
                <strong>{time(e.startsAt)}</strong>
              </span>
              <span className="grow">
                <span className={`tag ${e.type}`}>{TYPE_LABEL[e.type]}</span> {e.title}
                {e.cancelledAt && <span className="cancelled-note"> · Aflyst</span>}
                {e.location && <span className="muted small block">{e.location}</span>}
              </span>
              {!e.cancelledAt && (
                <span className="counts" title={`${e.yes} kommer, ${e.maybe} måske, ${e.no} kommer ikke`}>
                  <span className="yes">{e.yes}</span>
                  <span className="maybe">{e.maybe}</span>
                  <span className="no">{e.no}</span>
                  <span className="none">{Math.max(0, playerCount - e.yes - e.maybe - e.no)}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
      {!!events.length && <p className="muted small legend">Grøn: kommer · gul: måske · rød: kommer ikke · grå: ikke svaret</p>}

      <h2>Trænere</h2>
      <ul className="people">
        {team.coaches.map((c) => (
          <li key={c.profileId}>
            {c.firstName} {c.lastName}
          </li>
        ))}
        {team.coaches.length === 0 && <li className="muted">Ingen træner endnu</li>}
      </ul>
      {team.canManageCoaches && (
        <details>
          <summary className="small">Tilføj træner</summary>
          <form action={addCoach} className="inline">
            <input type="hidden" name="teamId" value={id} />
            <input type="email" name="email" required placeholder="Trænerens e-mail" />
            <button>Tilføj</button>
          </form>
          <p className="muted small">Personen skal have logget ind i HoldLiv én gang.</p>
        </details>
      )}

      <h2>Spillere</h2>
      <ul className="people">
        {team.players.map((p) => (
          <li key={p.profileId}>
            <span className="grow">
              {p.firstName} {p.lastName}
              {p.mine && <span className="muted"> (din)</span>}
              {p.guardians.length > 0 && (
                <span className="muted small block">
                  {p.guardians.map((g) => `${g.firstName} ${g.lastName}${g.phone ? `, ${g.phone}` : ""}`).join(" · ")}
                </span>
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

      {team.inviteCode && (
        <section className="card stack">
          <strong>Invitér spillere og forældre</strong>
          <p className="muted small">
            Del linket i fx holdets Facebook- eller Messenger-gruppe. Forældre logger ind, vælger deres barn og er med på holdet.
          </p>
          <input readOnly value={`${origin}/join/${team.inviteCode}`} className="mono" />
          <form action={newInviteLink}>
            <input type="hidden" name="teamId" value={id} />
            <button className="link small">Lav et nyt link (det gamle holder op med at virke)</button>
          </form>
        </section>
      )}
    </Shell>
  );
}
