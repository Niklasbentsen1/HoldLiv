import { MAX_DAYS_AHEAD, listScreens } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { origin } from "../../../lib/origin";
import { ErrorBox, Shell } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";
import { createScreenAction, deleteScreenAction, resetScreenTokenAction, updateScreenAction } from "../../actions";

export const dynamic = "force-dynamic";

function Fields({ s }: { s?: Awaited<ReturnType<typeof listScreens>>[number] }) {
  return (
    <>
      <label>
        Navn
        <input name="name" required maxLength={60} defaultValue={s?.name} placeholder="Fx Klubhuset" />
      </label>
      <label>
        Fast besked <span className="muted">(valgfri, vises øverst)</span>
        <input name="message" maxLength={300} defaultValue={s?.message ?? ""} placeholder="Fx Husk at tage skoene af i hallen" />
      </label>
      <div className="row">
        <label>
          Dage frem
          <input type="number" name="daysAhead" min={1} max={MAX_DAYS_AHEAD} defaultValue={s?.daysAhead ?? 3} />
        </label>
        <label className="check">
          <input type="checkbox" name="showNews" value="1" defaultChecked={s?.showNews ?? true} /> Vis foreningens nyheder
        </label>
      </div>
    </>
  );
}

export default async function Screens({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/skaerme?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const [screens, base] = await Promise.all([listScreens(db, ctx, klub), origin()]);

  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead
        back={{ href: "/forening", label: "Forening" }}
        title="Infoskærme"
        sub="En skærm i klubhuset eller hallen viser dagens aktiviteter og foreningens nyheder. Åbn linket i skærmens browser. Skærmen viser aldrig navne på personer, svar eller betalinger."
      />
      <ErrorBox message={fejl} />

      <details className="card">
        <summary className="title">Ny skærm</summary>
        <form action={createScreenAction} className="stack">
          <input type="hidden" name="clubId" value={klub} />
          <Fields />
          <button className="primary">Opret skærm</button>
        </form>
      </details>

      {screens.length === 0 && <Empty icon="star">Der er ingen skærme endnu.</Empty>}
      <ul className="events">
        {screens.map((s) => (
          <li key={s.id} className="card stack">
            <strong>{s.name}</strong>
            <span className="muted small block">
              Linket er hemmeligt: <a href={`${base}/skaerm/${s.token}`}>{`${base}/skaerm/${s.token}`}</a>
            </span>
            <details>
              <summary className="small">Ret, nulstil link eller slet</summary>
              <form action={updateScreenAction} className="stack">
                <input type="hidden" name="clubId" value={klub} />
                <input type="hidden" name="screenId" value={s.id} />
                <Fields s={s} />
                <button>Gem</button>
              </form>
              <form action={resetScreenTokenAction}>
                <input type="hidden" name="clubId" value={klub} />
                <input type="hidden" name="screenId" value={s.id} />
                <button className="link small">Nulstil linket (det gamle holder op med at virke)</button>
              </form>
              <form action={deleteScreenAction}>
                <input type="hidden" name="clubId" value={klub} />
                <input type="hidden" name="screenId" value={s.id} />
                <button className="link small">Slet skærmen</button>
              </form>
            </details>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
