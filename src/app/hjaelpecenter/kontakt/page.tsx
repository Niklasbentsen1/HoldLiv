import { listMySupportRequests, MAX_MESSAGE, MAX_SUBJECT } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell, ErrorBox } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { clubs } from "../../../db/schema";
import { inArray } from "drizzle-orm";
import { supportRequestAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function Contact({ searchParams }: { searchParams: Promise<{ fejl?: string; sendt?: string }> }) {
  const { fejl, sendt } = await searchParams;
  const { ctx } = await requireSession("/hjaelpecenter/kontakt");
  const mine = await listMySupportRequests(db, ctx);
  const adminClubs = ctx.adminClubs.size ? await db.select({ id: clubs.id, name: clubs.name }).from(clubs).where(inArray(clubs.id, [...ctx.adminClubs])) : [];
  return (
    <Shell active="/hjaelp" ctx={ctx}>
      <PageHead back={{ href: "/hjaelpecenter", label: "Hjælpecenter" }} title="Skriv til HoldLiv-support" sub="Vi svarer på den e-mail, du er logget ind med. Spørgsmål om en enkelt aktivitet eller betaling kan din forening ofte svare hurtigere på." />
      <ErrorBox message={fejl} />
      {sendt && <p className="card">Tak. Din henvendelse er sendt, og vi svarer på din e-mail.</p>}
      <form action={supportRequestAction} className="card stack" style={{ maxWidth: 560 }}>
        <label>
          Emne
          <input name="subject" required maxLength={MAX_SUBJECT} />
        </label>
        {adminClubs.length > 0 && (
          <label>
            Gælder foreningen
            <select name="clubId" defaultValue="">
              <option value="">Ingen bestemt</option>
              {adminClubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>
          Din besked
          <textarea name="message" rows={6} required maxLength={MAX_MESSAGE} />
        </label>
        <p className="muted small">Skriv ikke kodeord eller kortoplysninger. Skriv helst ikke om andre personer ved navn.</p>
        <button className="primary">Send</button>
      </form>
      {mine.length > 0 && (
        <section>
          <h2 className="section-head">Dine henvendelser</h2>
          <ul className="stack">
            {mine.map((r) => (
              <li key={r.id} className="card">
                <strong>{r.subject}</strong> <span className="pill">{r.status === "open" ? "Åben" : "Lukket"}</span>
                <span className="muted small block">{r.createdAt.toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}
