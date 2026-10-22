import { memberStats } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { localDate } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";

export const dynamic = "force-dynamic";

export default async function MemberCount({ searchParams }: { searchParams: Promise<{ klub?: string; dato?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/medlemstal");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const today = localDate(ctx.now);
  const asOf = p.dato && /^\d{4}-\d{2}-\d{2}$/.test(p.dato) ? p.dato : today;
  let stats: Awaited<ReturnType<typeof memberStats>> | null = null;
  let error = p.fejl;
  try {
    stats = await memberStats(db, ctx, club.id, asOf);
  } catch (e) {
    error = e instanceof Error ? e.message : "Noget gik galt.";
  }

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/medlemstal">
      <ErrorBox message={error} />
      <form method="get" className="inline">
        <input type="hidden" name="klub" value={club.id} />
        <label className="grow">
          Medlemstal pr.
          <input type="date" name="dato" defaultValue={asOf} />
        </label>
        <button>Vis</button>
      </form>
      {stats && (
        <>
          <p className="muted small">
            Aktive medlemmer den valgte dag, talt efter alder den dag. Tallene kan bruges til kommunens tilskud, DIF/DGI og foreningens eget regnskab. HoldLiv indberetter ikke selv og gemmer ingen CPR-numre eller adresser.
          </p>
          <ul className="people">
            {stats.bands.map((b) => (
              <li key={b.key} className="spread">
                <span>{b.label}</span>
                <span className="amount">{b.count}</span>
              </li>
            ))}
            {stats.unknown > 0 && (
              <li className="spread">
                <span>Uden fødselsdato</span>
                <span className="amount">{stats.unknown}</span>
              </li>
            )}
            <li className="spread">
              <strong>I alt</strong>
              <strong className="amount">{stats.total}</strong>
            </li>
            <li className="spread">
              <span>Heraf under 18 år</span>
              <span className="amount">{stats.under18}</span>
            </li>
            <li className="spread">
              <span>Heraf under 25 år</span>
              <span className="amount">{stats.under25}</span>
            </li>
          </ul>
          {stats.unknown > 0 && <p className="error">{stats.unknown} medlemmer mangler fødselsdato og indgår ikke i aldersgrupperne. Ret dem under Medlemmer, før tallet indberettes.</p>}

          <h2>Spillere pr. hold</h2>
          <ul className="people">
            {stats.perTeam.map((t) => (
              <li key={t.teamId} className="spread">
                <span>
                  {t.name}
                  {t.season ? <span className="muted small block">{t.season}</span> : null}
                </span>
                <span className="amount">{t.players}</span>
              </li>
            ))}
          </ul>
          <p className="small">
            <a href={`/kasse/medlemstal/eksport?klub=${club.id}&dato=${asOf}`}>Hent som regneark</a>
          </p>
        </>
      )}
    </KasseShell>
  );
}
