import { listTicketEvents, listTicketOrders } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { origin } from "../../../lib/origin";
import { kr } from "../../../lib/money";
import { toLocalInput } from "../../../lib/time";
import { when } from "../../../lib/format";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { cancelTicketEventAction, editTicketEvent, newTicketEvent, refundTicketOrderAction } from "../../actions";

export const dynamic = "force-dynamic";

const krInput = (ore: number) => (ore / 100).toString().replace(".", ",");
const STATUS = { paid: "Betalt", refunded: "Refunderet", pending: "Afventer", cancelled: "Annulleret" } as const;

function Fields({ e }: { e?: Awaited<ReturnType<typeof listTicketEvents>>[number] }) {
  return (
    <>
      <label>
        Navn
        <input name="name" required maxLength={120} defaultValue={e?.name} placeholder="Fx Hjemmekamp mod Hammel GF" />
      </label>
      <label>
        Beskrivelse (valgfri)
        <textarea name="description" rows={3} maxLength={2000} defaultValue={e?.description ?? ""} />
      </label>
      <div className="row">
        <label>
          Starter
          <input type="datetime-local" name="startsAt" required defaultValue={e ? toLocalInput(e.startsAt) : ""} />
        </label>
        <label>
          Sted
          <input name="location" maxLength={120} defaultValue={e?.location ?? ""} />
        </label>
      </div>
      <div className="row">
        <label>
          Pris pr. billet (kr.) <span className="muted">(0 = gratis)</span>
          <input name="price" required inputMode="decimal" defaultValue={e ? krInput(e.priceOre) : ""} placeholder="Fx 50" />
        </label>
        <label>
          Antal pladser <span className="muted">(tomt = ubegrænset)</span>
          <input name="capacity" type="number" min={1} max={100000} defaultValue={e?.capacity ?? ""} />
        </label>
      </div>
      <div className="row">
        <label>
          Salget lukker <span className="muted">(tomt = når det starter)</span>
          <input type="datetime-local" name="saleClosesAt" defaultValue={e?.saleClosesAt ? toLocalInput(e.saleClosesAt) : ""} />
        </label>
        <label>
          Højst pr. bestilling
          <input name="maxPerOrder" type="number" min={1} max={20} defaultValue={e?.maxPerOrder ?? 10} />
        </label>
      </div>
    </>
  );
}

export default async function TicketsAdmin({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/billetter");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const [list, base] = await Promise.all([listTicketEvents(db, ctx, club.id), origin()]);
  const orders = new Map(await Promise.all(list.filter((e) => e.sold > 0).map(async (e) => [e.id, await listTicketOrders(db, ctx, e.id)] as const)));

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/billetter">
      <ErrorBox message={p.fejl} />
      <details className="card">
        <summary className="title">Nyt arrangement med billetsalg</summary>
        <form action={newTicketEvent} className="stack">
          <input type="hidden" name="clubId" value={club.id} />
          <Fields />
          <p className="muted small">Pris og antal pladser bestemmer foreningen selv. Pengene går til foreningens egen Stripe-konto. Alle kan købe uden login.</p>
          <button className="primary">Opret</button>
        </form>
      </details>

      <ul className="events">
        {list.map((e) => (
          <li key={e.id} className="card stack">
            <div className="spread">
              <span className="title">{e.name}</span>
              <span className="amount">{e.priceOre === 0 ? "Gratis" : kr(e.priceOre)}</span>
            </div>
            <div className="muted small">
              {when(e.startsAt)} · {e.sold}
              {e.capacity !== null ? ` af ${e.capacity}` : ""} billetter solgt, {e.used} scannet ind · {kr(e.revenueOre)} i alt
              {e.held > 0 ? ` · ${e.held} pladser holdes af igangværende køb` : ""}
              {e.cancelledAt ? " · AFLYST" : ""}
            </div>
            <span className="muted small block">
              Salgsside: <a href={`${base}/billetter/${e.id}`}>{`${base}/billetter/${e.id}`}</a>
            </span>
            {(orders.get(e.id) ?? []).length > 0 && (
              <ul className="people">
                {orders.get(e.id)!.map((o) => (
                  <li key={o.id} className="spread">
                    <span className="grow">
                      {o.buyerName} · {o.quantity} stk.
                      <span className="muted small block">
                        {o.buyerEmail} · {STATUS[o.status]} · {kr(o.amountOre)}
                      </span>
                    </span>
                    {o.status === "paid" && (
                      <form action={refundTicketOrderAction}>
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="orderId" value={o.id} />
                        <button>Refundér</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!e.cancelledAt && (
              <>
                <details>
                  <summary className="small">Ret arrangementet</summary>
                  <form action={editTicketEvent} className="stack">
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="ticketEventId" value={e.id} />
                    <Fields e={e} />
                    <p className="muted small">Ny pris gælder kun nye bestillinger. Solgte billetter beholder deres pris.</p>
                    <button>Gem</button>
                  </form>
                </details>
                <form action={cancelTicketEventAction}>
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="ticketEventId" value={e.id} />
                  <button>Aflys arrangementet (salget lukker; betalte køb skal refunderes)</button>
                </form>
              </>
            )}
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="muted">Ingen arrangementer med billetsalg endnu.</p>}
      <p className="muted small">Billetterne scannes med telefonens kamera: koden åbner en side, hvor admin, kasserer og trænere logger ind og trykker "Slip ind".</p>
    </KasseShell>
  );
}
