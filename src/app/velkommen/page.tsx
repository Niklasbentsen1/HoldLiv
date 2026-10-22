import { redirect } from "next/navigation";
import { getSession, getUserId, safeNext } from "../../lib/session";
import { Bare, ErrorBox } from "../../components/Shell";
import { completeProfile } from "../actions";

export const dynamic = "force-dynamic";

export default async function Welcome({ searchParams }: { searchParams: Promise<{ next?: string; fejl?: string }> }) {
  const sp = await searchParams;
  if (!(await getUserId())) redirect("/login");
  if (await getSession()) redirect(safeNext(sp.next));
  return (
    <Bare>
      <section className="card stack">
        <h1>Velkommen til HoldLiv</h1>
        <p className="muted">Fortæl os hvem du er. Dine børn tilføjer du bagefter under Familie.</p>
        <ErrorBox message={sp.fejl} />
        <form action={completeProfile} className="stack">
          <input type="hidden" name="next" value={safeNext(sp.next)} />
          <div className="row">
            <label>
              Fornavn
              <input name="firstName" required autoComplete="given-name" />
            </label>
            <label>
              Efternavn
              <input name="lastName" required autoComplete="family-name" />
            </label>
          </div>
          <label>
            Telefon <span className="muted">(valgfri, så træneren kan ringe)</span>
            <input name="phone" type="tel" autoComplete="tel" />
          </label>
          <label>
            Fødselsdato <span className="muted">(valgfri)</span>
            <input name="birthDate" type="date" />
          </label>
          <label className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="privacy" required style={{ width: "auto", marginTop: 4 }} />
            <span>
              Jeg har læst og accepterer <a href="/privatliv" target="_blank" rel="noreferrer">privatlivspolitikken</a>.
            </span>
          </label>
          <button className="primary">Fortsæt</button>
        </form>
      </section>
    </Bare>
  );
}
