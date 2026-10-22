import { headers } from "next/headers";
import { listSignups } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell, ErrorBox } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";
import { clubs, teams } from "../../../db/schema";
import { asc, eq } from "drizzle-orm";
import { decideSignupAction, saveSignupSettingsAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function Signups({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/tilmeldinger?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const [club] = await db.select().from(clubs).where(eq(clubs.id, klub));
  const clubTeams = await db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.clubId, klub)).orderBy(asc(teams.name));
  const pending = await listSignups(db, ctx, klub);
  const h = await headers();
  const origin = process.env.APP_URL ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host")}`;
  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead title="Indmeldelse" sub={`Nye medlemmer til ${club.name}`} />
      <ErrorBox message={fejl} />
      <section className="card stack" style={{ marginBottom: 20 }}>
        <h2 className="section-head">Åbent tilmeldingslink</h2>
        <form action={saveSignupSettingsAction} className="stack">
          <input type="hidden" name="clubId" value={klub} />
          <label className="check">
            <input type="checkbox" name="enabled" defaultChecked={club.signupEnabled} /> Åbn for online indmeldelse
          </label>
          {club.signupEnabled && <input readOnly value={`${origin}/tilmeld/${club.slug}`} className="mono" />}
          <div className="row">
            <label>
              Mindstealder <span className="muted">(tomt = ingen)</span>
              <input name="minAge" type="number" min={0} max={120} defaultValue={club.signupMinAge ?? ""} />
            </label>
            <label>
              Højeste alder <span className="muted">(tomt = ingen)</span>
              <input name="maxAge" type="number" min={0} max={120} defaultValue={club.signupMaxAge ?? ""} />
            </label>
          </div>
          <label>
            Foreningens betingelser <span className="muted">(vises, og ansøgeren skal acceptere dem)</span>
            <textarea name="terms" rows={5} maxLength={5000} defaultValue={club.signupTerms ?? ""} />
          </label>
          <button>Gem</button>
        </form>
      </section>
      <div className="section-head">
        <h2>Ansøgninger</h2>
        <span className="pill">{pending.length}</span>
      </div>
      {pending.length === 0 && <Empty>Ingen ansøgninger venter.</Empty>}
      <ul className="stack">
        {pending.map((r) => (
          <li key={r.id} className="card stack">
            <strong>
              {r.firstName} {r.lastName} <span className="muted">· {r.age} år</span>
            </strong>
            <span className="muted small">
              {r.contactEmail}
              {r.phone ? ` · ${r.phone}` : ""}
              {r.guardianName ? ` · forælder: ${r.guardianName}` : ""}
            </span>
            {r.message && <span className="small">{r.message}</span>}
            <form action={decideSignupAction} className="inline">
              <input type="hidden" name="clubId" value={klub} />
              <input type="hidden" name="requestId" value={r.id} />
              <select name="teamId" defaultValue={r.teamId ?? ""} aria-label="Hold">
                <option value="">Intet hold</option>
                {clubTeams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button name="intent" value="approve" className="primary">Godkend</button>
              <input name="note" placeholder="Besked ved afvisning" aria-label="Besked ved afvisning" />
              <button name="intent" value="reject" className="link">Afvis</button>
            </form>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
