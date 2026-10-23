import { requireSession } from "../../lib/session";
import { origin } from "../../lib/origin";
import { Bare, ErrorBox } from "../../components/Shell";
import { registerClubAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function CreateClub({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  await requireSession("/opret-forening");
  const base = await origin();
  return (
    <Bare>
      <section className="card stack">
        <h1>Opret jeres forening</h1>
        <p className="muted">Du bliver foreningens første administrator. Bagefter guider vi dig igennem hold, medlemmer og indmeldelse. Det tager få minutter.</p>
        <ErrorBox message={fejl} />
        <form action={registerClubAction} className="stack">
          <label>
            Foreningens navn
            <input name="name" required maxLength={80} placeholder="fx Skovby IF" autoComplete="organization" />
          </label>
          <label>
            Adresse til hjemmesiden <span className="muted">(valgfri, ellers laver vi den ud fra navnet)</span>
            <input name="slug" maxLength={50} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="skovby-if" className="mono" />
            <span className="muted small">{base}/klub/…</span>
          </label>
          <label className="check">
            <input type="checkbox" name="terms" required /> Jeg må oprette og administrere foreningen
          </label>
          <button className="primary">Opret forening</button>
        </form>
      </section>
    </Bare>
  );
}
