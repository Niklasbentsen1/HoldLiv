import Link from "next/link";
import { inArray } from "drizzle-orm";
import { listConsents, previewDeletion } from "../../../services";
import { profiles } from "../../../db/schema";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell, ErrorBox } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { deleteAccountAction, deleteChildAction, saveConsent } from "../../actions";

export const dynamic = "force-dynamic";

export default async function Privacy({ searchParams }: { searchParams: Promise<{ fejl?: string; gemt?: string }> }) {
  const { fejl, gemt } = await searchParams;
  const { ctx } = await requireSession("/indstillinger/privatliv");
  const ids = [ctx.profileId, ...ctx.wards];
  const people = await db.select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(inArray(profiles.id, ids));
  const withConsents = await Promise.all(people.map(async (p) => ({ ...p, consents: await listConsents(db, ctx, p.id) })));
  const plan = await previewDeletion(db, ctx);

  return (
    <Shell active="/indstillinger" ctx={ctx}>
      <PageHead title="Privatliv" sub="Samtykker, dine data og sletning. Læs også vores privatlivspolitik." />
      <ErrorBox message={fejl} />
      {gemt && <p className="pill">Gemt</p>}

      <section className="card stack" style={{ marginBottom: 20 }}>
        <h2 className="section-head">Samtykker</h2>
        {withConsents.map((p) => (
          <div key={p.id} className="stack">
            <strong>{p.id === ctx.profileId ? "Dig" : `${p.firstName} ${p.lastName}`}</strong>
            {p.consents.map((c) => (
              <form key={c.kind} action={saveConsent} className="row" style={{ justifyContent: "space-between", gap: 12 }}>
                <input type="hidden" name="profileId" value={p.id} />
                <input type="hidden" name="kind" value={c.kind} />
                <input type="hidden" name="granted" value={c.granted ? "0" : "1"} />
                <span>
                  {c.label}
                  <span className="muted small block">{c.description}</span>
                </span>
                {c.required && c.granted ? <span className="pill">Givet</span> : <button>{c.granted ? "Træk tilbage" : "Giv samtykke"}</button>}
              </form>
            ))}
          </div>
        ))}
        <p className="muted small">
          <Link href="/privatliv">Privatlivspolitik</Link>
        </p>
      </section>

      <section className="card stack" style={{ marginBottom: 20 }}>
        <h2 className="section-head">Hent dine data</h2>
        <p className="muted">En fil med alt, HoldLiv har om dig og dine børn: profil, medlemskab, tilmeldinger, beskeder, opkrævninger og samtykker.</p>
        <a className="button" href="/indstillinger/privatliv/eksport" download>Hent som fil</a>
      </section>

      {[...ctx.wards].length > 0 && (
        <section className="card stack" style={{ marginBottom: 20 }}>
          <h2 className="section-head">Slet et barns data</h2>
          <p className="muted small">Har barnet en anden værge, fjerner du kun dig selv som værge, og barnets profil bliver hos den anden.</p>
          {withConsents.filter((p) => p.id !== ctx.profileId).map((p) => (
            <form key={p.id} action={deleteChildAction} className="row" style={{ justifyContent: "space-between" }}>
              <input type="hidden" name="profileId" value={p.id} />
              <span>{p.firstName} {p.lastName}</span>
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" name="sure" required style={{ width: "auto" }} /> Jeg er sikker
              </label>
              <button>Slet</button>
            </form>
          ))}
        </section>
      )}

      <section className="card stack">
        <h2 className="section-head">Slet min konto</h2>
        <p className="muted">
          Dit login, dine beskeder, opslag, tilmeldinger og oplysninger slettes. Opkrævninger og betalinger gemmes uden navn, fordi bogføringsloven kræver det.
          {plan.people.length > 1 && ` Børn, hvor du er eneste værge, slettes også: ${plan.people.filter((p) => !p.self).map((p) => p.name).join(", ")}.`}
          {plan.people.some((p) => p.ownLogin) && " Mindst ét af børnene har eget login, som også slettes."}
        </p>
        {plan.blockers.map((b) => (
          <p key={b} className="error">{b}</p>
        ))}
        <form action={deleteAccountAction} className="stack">
          <label>
            Skriv din e-mail for at bekræfte
            <input name="email" type="email" required autoComplete="off" />
          </label>
          <button disabled={plan.blockers.length > 0}>Slet min konto</button>
        </form>
      </section>
    </Shell>
  );
}
