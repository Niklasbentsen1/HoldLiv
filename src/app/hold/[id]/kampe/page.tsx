import Link from "next/link";
import { getTeam, getTeamStats, listMatches } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { shortDay, time } from "../../../../lib/format";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Avatar, DateTile, Empty, Icon, PageHead, Stat } from "../../../../components/ui";

export const dynamic = "force-dynamic";

const OUTCOME = { win: "Sejr", draw: "Uafgjort", loss: "Nederlag" } as const;

export default async function Matches({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/kampe`);
  const team = await getTeam(db, ctx, id);
  const [list, stats] = await Promise.all([listMatches(db, ctx, id), getTeamStats(db, ctx, id)]);
  const r = stats.record;
  const goalDiff = r.goalsFor - r.goalsAgainst;

  return (
    <Shell ctx={ctx}>
      <PageHead
        back={{ href: `/hold/${id}`, label: team.name }}
        title="Kampe og opstilling"
        sub="Opstilling til næste kamp, resultater og referater, og holdets statistik. Kampene oprettes i kalenderen som aktiviteter af typen kamp."
      />
      <ErrorBox message={fejl} />

      <div className="tiles" style={{ marginBottom: 20 }}>
        <Stat label="Spillede kampe" value={r.played} icon="ball" hint={r.played ? `${r.wins} sejre · ${r.draws} uafgjort · ${r.losses} nederlag` : "ingen endnu"} tone="brand" />
        <Stat label="Mål for og imod" value={`${r.goalsFor}–${r.goalsAgainst}`} icon="star" hint={r.played ? `${goalDiff > 0 ? "+" : ""}${goalDiff} i målforskel` : undefined} />
        <Stat label="Næste kamp" value={list.upcoming[0] ? shortDay(list.upcoming[0].startsAt) : "Ingen"} icon="calendar" hint={list.upcoming[0]?.lineupPublished ? "opstillingen er klar" : list.upcoming[0] ? "opstilling ikke udgivet" : undefined} />
      </div>

      <div className="team-layout">
        <div className="dash-main">
          <section className="section">
            <div className="section-head">
              <h2>Kommende kampe</h2>
            </div>
            {list.upcoming.length === 0 && <Empty icon="ball">Ingen kommende kampe. Opret en aktivitet af typen kamp i kalenderen.</Empty>}
            <ul className="people">
              {list.upcoming.map((m) => (
                <li key={m.eventId}>
                  <DateTile date={m.startsAt} type="match" />
                  <span className="grow">
                    <Link href={`/hold/${id}/kampe/${m.eventId}`} className="name">
                      {m.title}
                    </Link>
                    <span className="note">
                      kl. {time(m.startsAt)}
                      {m.location ? ` · ${m.location}` : ""}
                    </span>
                  </span>
                  <span className={m.lineupPublished ? "pill brand" : "pill"}>{m.lineupPublished ? "Opstilling klar" : list.canManage ? (m.draft ? "Kladde" : "Mangler opstilling") : "Opstilling følger"}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Spillede kampe</h2>
            </div>
            {list.past.length === 0 && <Empty icon="ball">Ingen kampe endnu.</Empty>}
            <ul className="people">
              {list.past.map((m) => (
                <li key={m.eventId} className={m.cancelled ? "cancelled" : undefined}>
                  <DateTile date={m.startsAt} type="match" />
                  <span className="grow">
                    <Link href={`/hold/${id}/kampe/${m.eventId}`} className={m.cancelled ? "name strike" : "name"}>
                      {m.title}
                    </Link>
                    <span className="note">
                      {m.cancelled ? "Aflyst" : m.played ? `${shortDay(m.startsAt)}${m.hasReport ? " · referat" : ""}` : "Resultat mangler"}
                    </span>
                  </span>
                  {m.played && (
                    <span className="pill brand">
                      {m.goalsFor}–{m.goalsAgainst}
                    </span>
                  )}
                  {!m.played && !m.cancelled && list.canManage && <span className="pill cancel">Indtast resultat</span>}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <aside className="dash-side">
          <section className="card stack">
            <strong>{stats.rankingsShown ? "Spillerne" : "Dine tal"}</strong>
            {!stats.rankingsShown && <p className="muted small">Holdet viser ikke en rangliste. Du ser dine egne tal, og trænerne ser alle.</p>}
            {stats.players.length === 0 && <p className="muted small">Ingen tal endnu.</p>}
            <ul className="people" style={{ boxShadow: "none", padding: 0 }}>
              {stats.players.map((p) => (
                <li key={p.profileId}>
                  <Avatar name={p.name} />
                  <span className="grow">
                    <span className="name">{p.name}</span>
                    <span className="note">
                      {p.matches} kampe · {p.starts} starter{p.minutes ? ` · ${p.minutes} min.` : ""}
                    </span>
                    <span className="note">
                      {p.goals} mål · {p.assists} assists{p.yellow ? ` · ${p.yellow} gule` : ""}
                      {p.red ? ` · ${p.red} røde` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {stats.results.length > 0 && (
            <section className="card stack">
              <strong>Resultater</strong>
              {stats.results.map((x) => (
                <div key={x.eventId} className="row" style={{ justifyContent: "space-between" }}>
                  <Link href={`/hold/${id}/kampe/${x.eventId}`} className="small">
                    {x.opponent ?? x.title}
                  </Link>
                  <span className={x.outcome === "loss" ? "pill cancel" : "pill brand"} title={OUTCOME[x.outcome]}>
                    {x.goalsFor}–{x.goalsAgainst}
                  </span>
                </div>
              ))}
            </section>
          )}
          {list.canManage && (
            <p className="muted small">
              <Icon name="bell" size={14} /> Antal spillere på banen og rangliste stilles under <Link href={`/hold/${id}/moduler`}>Moduler</Link>.
            </p>
          )}
        </aside>
      </div>
    </Shell>
  );
}
