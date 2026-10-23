import Link from "next/link";
import { listBookableResources, listMyBookings } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { kr } from "../../lib/money";
import { time, shortDay, when } from "../../lib/format";
import { ErrorBox, Shell } from "../../components/Shell";
import { PageHead } from "../../components/ui";
import { bookResourceAction, cancelBookingAction } from "../actions";

export const dynamic = "force-dynamic";

const KIND = { court: "Bane", hall: "Hal", equipment: "Udstyr" } as const;

export default async function Booking({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/booking");
  const [resources, mine] = await Promise.all([listBookableResources(db, ctx), listMyBookings(db, ctx)]);

  return (
    <Shell ctx={ctx} active="/betaling">
      <PageHead title="Book baner, haller og udstyr" sub="Vælg tid, og se hvad der allerede er booket de næste 14 dage." />
      <ErrorBox message={fejl} />

      {mine.length > 0 && (
        <section>
          <h2>Mine bookinger</h2>
          <ul className="events">
            {mine.map((b) => (
              <li key={b.id} className="card spread">
                <span className="grow">
                  <strong className="block">
                    {b.resourceName}
                    {b.quantity > 1 ? ` (${b.quantity} stk.)` : ""}
                  </strong>
                  <span className="muted small block">
                    {when(b.startsAt, b.endsAt)}
                    {b.teamName ? ` · ${b.teamName}` : b.profileId !== ctx.profileId ? ` · ${b.firstName}` : ""}
                    {b.status === "pending" ? " · afventer foreningens godkendelse" : ""}
                    {b.amountOre ? ` · leje ${kr(b.amountOre)} under Betaling` : ""}
                  </span>
                </span>
                <form action={cancelBookingAction}>
                  <input type="hidden" name="bookingId" value={b.id} />
                  <button>Afbook</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {resources.length === 0 && <p className="muted">Din forening har ikke lagt baner, haller eller udstyr ind endnu.</p>}
      <ul className="events">
        {resources.map((r) => (
          <li key={r.id} className="card stack">
            <div className="spread">
              <span className="title">{r.name}</span>
              <span className="amount">{r.pricePerHourOre > 0 ? `${kr(r.pricePerHourOre)} i timen` : "Gratis"}</span>
            </div>
            <div className="muted small">
              {KIND[r.kind]}
              {r.quantity > 1 ? ` · ${r.quantity} stk.` : ""}
              {r.requiresApproval ? " · skal godkendes af foreningen" : ""}
              {r.description ? ` · ${r.description}` : ""}
            </div>
            <div className="small">
              {r.busy.length === 0 ? (
                "Ingen bookinger de næste 14 dage."
              ) : (
                <ul className="people">
                  {r.busy.map((b, i) => (
                    <li key={i} className="muted">
                      {shortDay(b.startsAt)} kl. {time(b.startsAt)}–{time(b.endsAt)}: {b.who}
                      {b.quantity > 1 ? ` (${b.quantity} stk.)` : ""}
                      {b.pending ? " (afventer)" : ""}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <details>
              <summary className="small">Book</summary>
              <form action={bookResourceAction} className="stack">
                <input type="hidden" name="resourceId" value={r.id} />
                <div className="row">
                  <label>
                    Fra
                    <input type="datetime-local" name="startsAt" required />
                  </label>
                  <label>
                    Til
                    <input type="datetime-local" name="endsAt" required />
                  </label>
                </div>
                {r.quantity > 1 && (
                  <label>
                    Antal
                    <input type="number" name="quantity" min={1} max={r.quantity} defaultValue={1} />
                  </label>
                )}
                <label>
                  Booker til
                  <select name="profileId">
                    {r.people.map((p) => (
                      <option key={p.profileId} value={p.profileId}>
                        {p.self ? "Mig selv" : p.firstName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Note <span className="muted">(valgfri)</span>
                  <input name="note" maxLength={200} />
                </label>
                <button className="primary">Book</button>
              </form>
            </details>
            {r.teams.length > 0 && (
              <details>
                <summary className="small">Book til et hold (uden leje)</summary>
                <form action={bookResourceAction} className="stack">
                  <input type="hidden" name="resourceId" value={r.id} />
                  <label>
                    Hold
                    <select name="teamId">
                      {r.teams.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="row">
                    <label>
                      Fra
                      <input type="datetime-local" name="startsAt" required />
                    </label>
                    <label>
                      Til
                      <input type="datetime-local" name="endsAt" required />
                    </label>
                  </div>
                  {r.quantity > 1 && (
                    <label>
                      Antal
                      <input type="number" name="quantity" min={1} max={r.quantity} defaultValue={1} />
                    </label>
                  )}
                  <button className="primary">Book til holdet</button>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
      <p className="small">
        <Link href="/betaling">Til Betaling</Link>
      </p>
    </Shell>
  );
}
