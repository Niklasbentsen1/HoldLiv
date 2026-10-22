import Link from "next/link";
import { listFamily } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
import { Avatar, Crest, PageHead } from "../../components/ui";
import { addChild, addGuardian } from "../actions";

export const dynamic = "force-dynamic";

const age = (birthDate: string | null, now: Date) => {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.split("-").map(Number);
  let a = now.getFullYear() - y;
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) a--;
  return a;
};

export default async function Family({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/familie");
  const kids = await listFamily(db, ctx);

  return (
    <Shell active="/familie" admin={ctx.adminClubs.size > 0}>
      <PageHead title="Familie" sub="Børn har ikke eget login. Du melder til og fra for dem, og du kan skifte til dem på overblikket." />
      <ErrorBox message={fejl} />
      <div className="team-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", marginBottom: 20 }}>

      {kids.map((k) => (
        <section key={k.id} className="card stack">
          <div className="team-hero">
            <Avatar name={`${k.firstName} ${k.lastName}`} size={56} />
            <div>
              <strong style={{ fontSize: 20 }}>
                {k.firstName} {k.lastName}
              </strong>
              <div className="muted">{age(k.birthDate, ctx.now)} år</div>
            </div>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {k.teams.length ? (
              k.teams.map((t) => (
                <Link key={t.id} href={`/hold/${t.id}`} className="team-card" style={{ padding: 10, background: "var(--surface-2)", borderRadius: "var(--r-md)" }}>
                  <Crest name={t.name} size={28} />
                  <strong className="grow" style={{ fontSize: 15 }}>{t.name}</strong>
                </Link>
              ))
            ) : (
              <span className="muted small">Ikke på et hold endnu. Bed træneren om holdets invitationslink.</span>
            )}
          </div>
          <div className="small muted">
            Andre forældre: {k.otherGuardians.length ? k.otherGuardians.join(", ") : "ingen"}
          </div>
          <details>
            <summary className="small">Tilføj den anden forælder</summary>
            <form action={addGuardian} className="inline">
              <input type="hidden" name="childId" value={k.id} />
              <input type="email" name="email" required placeholder="Den anden forælders e-mail" />
              <button>Tilføj</button>
            </form>
            <p className="muted small">Personen skal have logget ind i HoldLiv én gang.</p>
          </details>
        </section>
      ))}
      </div>

      <section className="card stack" style={{ maxWidth: 560 }}>
        <h2 className="flush">Tilføj barn</h2>
        <form action={addChild} className="stack">
          <div className="row">
            <label>
              Fornavn
              <input name="firstName" required />
            </label>
            <label>
              Efternavn
              <input name="lastName" required />
            </label>
          </div>
          <label>
            Fødselsdato
            <input name="birthDate" type="date" required />
          </label>
          <button className="primary">Tilføj barn</button>
        </form>
      </section>
    </Shell>
  );
}
