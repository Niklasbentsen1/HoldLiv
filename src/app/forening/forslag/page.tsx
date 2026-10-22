import { analyseClub } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";
import { AdviceBox } from "./AdviceBox";

export const dynamic = "force-dynamic";

const SEVERITY = { high: "Vigtigt", medium: "Bør overvejes", low: "Til info" } as const;
const age = (min: number | null, max: number | null) => (min === null || max === null ? "–" : min === max ? `${min} år` : `${min}-${max} år`);

export default async function Suggestions({ searchParams }: { searchParams: Promise<{ klub?: string }> }) {
  const { klub } = await searchParams;
  const { ctx } = await requireSession(`/forening/forslag?klub=${klub ?? ""}`);
  if (!klub) return <Shell ctx={ctx}>Vælg en forening.</Shell>;
  const { teams, suggestions } = await analyseClub(db, ctx, klub);
  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead title="Holdforslag" sub="Forslag til nye hold, flere pladser, trænere og ledige tider, ud fra ventelister, kapacitet og træningstider." />
      {suggestions.length === 0 ? (
        <Empty>Ingen forslag lige nu. Holdene ser ud til at have plads og trænere nok.</Empty>
      ) : (
        <ul className="stack">
          {suggestions.map((s) => (
            <li key={s.title} className="card">
              <span className={s.severity === "high" ? "pill brand" : "pill"}>{SEVERITY[s.severity]}</span>
              <strong className="block">{s.title}</strong>
              <span className="muted small block">{s.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <section style={{ margin: "20px 0" }}>
        <h2 className="section-head">Hold</h2>
        <ul className="stack">
          {teams.map((t) => (
            <li key={t.teamId} className="card row" style={{ justifyContent: "space-between", gap: 12 }}>
              <strong>{t.name}</strong>
              <span className="muted small">
                {t.players}
                {t.capacity !== null ? `/${t.capacity}` : ""} spillere · {t.waiting} på venteliste · {t.coaches} {t.coaches === 1 ? "træner" : "trænere"} · {age(t.ageMin, t.ageMax)}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <AdviceBox clubId={klub} />
    </Shell>
  );
}
