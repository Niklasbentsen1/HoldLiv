import Link from "next/link";
import { listFamily } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
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
      <h1>Familie</h1>
      <p className="muted">
        Børn har ikke eget login. Du melder til og fra for dem, og du kan skifte til dem i kalenderen.
      </p>
      <ErrorBox message={fejl} />

      {kids.map((k) => (
        <section key={k.id} className="card stack">
          <div>
            <strong>
              {k.firstName} {k.lastName}
            </strong>{" "}
            <span className="muted">{age(k.birthDate, ctx.now)} år</span>
          </div>
          <div className="small">
            {k.teams.length ? (
              k.teams.map((t, i) => (
                <span key={t.id}>
                  {i > 0 && ", "}
                  <Link href={`/hold/${t.id}`}>{t.name}</Link>
                </span>
              ))
            ) : (
              <span className="muted">Ikke på et hold endnu. Bed træneren om holdets invitationslink.</span>
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

      <section className="card stack">
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
