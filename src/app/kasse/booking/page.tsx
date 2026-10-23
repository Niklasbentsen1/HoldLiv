import { listClubBookings, listClubResources } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr } from "../../../lib/money";
import { when } from "../../../lib/format";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { archiveResourceAction, cancelBookingAction, decideBookingAction, editResource, newResource } from "../../actions";

export const dynamic = "force-dynamic";

const krInput = (ore: number) => (ore / 100).toString().replace(".", ",");
const KIND = { court: "Bane", hall: "Hal", equipment: "Udstyr" } as const;
const CHARGE = { open: "Ikke betalt", paid: "Betalt", cancelled: "Annulleret", refunded: "Refunderet" } as const;

function Fields({ r }: { r?: Awaited<ReturnType<typeof listClubResources>>[number] }) {
  return (
    <>
      <div className="row">
        <label>
          Navn
          <input name="name" required maxLength={120} defaultValue={r?.name} placeholder="Fx Bane 1" />
        </label>
        <label>
          Type
          <select name="kind" defaultValue={r?.kind ?? "court"}>
            <option value="court">Bane</option>
            <option value="hall">Hal</option>
            <option value="equipment">Udstyr</option>
          </select>
        </label>
      </div>
      <label>
        Beskrivelse (valgfri)
        <input name="description" defaultValue={r?.description ?? ""} />
      </label>
      <div className="row">
        <label>
          Leje pr. time (kr.) <span className="muted">(0 = gratis)</span>
          <input name="price" inputMode="decimal" defaultValue={r ? krInput(r.pricePerHourOre) : "0"} />
        </label>
        <label>
          Antal enheder
          <input name="quantity" type="number" min={1} max={1000} defaultValue={r?.quantity ?? 1} />
        </label>
      </div>
      <label className="row">
        <input type="checkbox" name="requiresApproval" value="1" defaultChecked={r?.requiresApproval} />
        Medlemmers bookinger skal godkendes af foreningen
      </label>
    </>
  );
}

export default async function BookingAdmin({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/booking");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const [resources, upcoming] = await Promise.all([listClubResources(db, ctx, club.id), listClubBookings(db, ctx, club.id)]);

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/booking">
      <ErrorBox message={p.fejl} />
      <details className="card">
        <summary className="title">Ny bane, hal eller udstyr</summary>
        <form action={newResource} className="stack">
          <input type="hidden" name="clubId" value={club.id} />
          <Fields />
          <p className="muted small">Lejen bestemmer foreningen selv. Hold i foreningen booker uden leje; medlemmer får en opkrævning under Betaling.</p>
          <button className="primary">Opret</button>
        </form>
      </details>

      <h2>Bookinger</h2>
      {upcoming.length === 0 && <p className="muted">Ingen kommende bookinger.</p>}
      <ul className="events">
        {upcoming.map((b) => (
          <li key={b.id} className="card spread">
            <span className="grow">
              <strong className="block">
                {b.resourceName}
                {b.quantity > 1 ? ` (${b.quantity} stk.)` : ""}
              </strong>
              <span className="muted small block">
                {when(b.startsAt, b.endsAt)} · {b.teamName ?? `${b.firstName} ${b.lastName}`}
                {b.status === "pending" ? " · AFVENTER GODKENDELSE" : ""}
                {b.amountOre !== null ? ` · ${kr(b.amountOre)} (${b.chargeStatus ? CHARGE[b.chargeStatus] : ""})` : ""}
                {b.note ? ` · ${b.note}` : ""}
              </span>
            </span>
            {b.status === "pending" ? (
              <form action={decideBookingAction} className="row">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="bookingId" value={b.id} />
                <button name="approve" value="1" className="primary">
                  Godkend
                </button>
                <button name="approve" value="0">
                  Afvis
                </button>
              </form>
            ) : (
              <form action={cancelBookingAction}>
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="bookingId" value={b.id} />
                <button>Afbook</button>
              </form>
            )}
          </li>
        ))}
      </ul>

      <h2>Baner, haller og udstyr</h2>
      {resources.length === 0 && <p className="muted">Ingen endnu.</p>}
      <ul className="events">
        {resources.map((r) => (
          <li key={r.id} className="card stack">
            <div className="spread">
              <span className="title">{r.name}</span>
              <span className="amount">{r.pricePerHourOre > 0 ? `${kr(r.pricePerHourOre)} i timen` : "Gratis"}</span>
            </div>
            <div className="muted small">
              {KIND[r.kind]} · {r.quantity} stk.
              {r.requiresApproval ? " · skal godkendes" : ""}
            </div>
            <details>
              <summary className="small">Ret</summary>
              <form action={editResource} className="stack">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="resourceId" value={r.id} />
                <Fields r={r} />
                <p className="muted small">Ny leje gælder kun nye bookinger.</p>
                <button>Gem</button>
              </form>
            </details>
            <form action={archiveResourceAction}>
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="resourceId" value={r.id} />
              <button>Arkivér</button>
            </form>
          </li>
        ))}
      </ul>
    </KasseShell>
  );
}
