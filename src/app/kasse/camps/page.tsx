import { listCampSignups, listClubCamps } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr, longDate } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { cancelCampAction, cancelCampSignupAction, editCamp, newCamp } from "../../actions";

export const dynamic = "force-dynamic";

const krInput = (ore: number) => (ore / 100).toString().replace(".", ",");
const CHARGE = { open: "Ikke betalt", paid: "Betalt", cancelled: "Annulleret", refunded: "Refunderet" } as const;

function Fields({ c }: { c?: Awaited<ReturnType<typeof listClubCamps>>[number] }) {
  return (
    <>
      <label>
        Navn
        <input name="name" required maxLength={120} defaultValue={c?.name} placeholder="Fx Sommercamp 2027" />
      </label>
      <label>
        Beskrivelse (valgfri)
        <input name="description" defaultValue={c?.description ?? ""} />
      </label>
      <div className="row">
        <label>
          Første dag
          <input type="date" name="startsOn" required defaultValue={c?.startsOn} />
        </label>
        <label>
          Sidste dag
          <input type="date" name="endsOn" required defaultValue={c?.endsOn} />
        </label>
      </div>
      <div className="row">
        <label>
          Pris (kr.)
          <input name="price" required inputMode="decimal" defaultValue={c ? krInput(c.priceOre) : ""} placeholder="Fx 1.200" />
        </label>
        <label>
          Søskenderabat (%)
          <input name="siblingDiscount" type="number" min={0} max={100} defaultValue={c?.siblingDiscountPercent ?? 0} />
        </label>
      </div>
      <div className="row">
        <label>
          Antal pladser <span className="muted">(tomt = ubegrænset)</span>
          <input name="capacity" type="number" min={0} max={5000} defaultValue={c?.capacity ?? ""} />
        </label>
        <label>
          Tilmelding senest <span className="muted">(tomt = til campen er slut)</span>
          <input type="date" name="signupDeadline" defaultValue={c?.signupDeadline ?? ""} />
        </label>
      </div>
    </>
  );
}

export default async function CampsAdmin({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/camps");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const camps = await listClubCamps(db, ctx, club.id);
  const signups = new Map(await Promise.all(camps.filter((c) => c.confirmed + c.waiting > 0).map(async (c) => [c.id, await listCampSignups(db, ctx, c.id)] as const)));

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/camps">
      <ErrorBox message={p.fejl} />
      <details className="card">
        <summary className="title">Ny camp</summary>
        <form action={newCamp} className="stack">
          <input type="hidden" name="clubId" value={club.id} />
          <Fields />
          <p className="muted small">Pris, pladser og rabat bestemmer foreningen selv. Hver, der får en plads, får en opkrævning under Betaling.</p>
          <button className="primary">Opret camp</button>
        </form>
      </details>

      <ul className="events">
        {camps.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="title">{c.name}</span>
              <span className="amount">{kr(c.priceOre)}</span>
            </div>
            <div className="muted small">
              {longDate(c.startsOn)}
              {c.endsOn !== c.startsOn ? ` – ${longDate(c.endsOn)}` : ""} · {c.confirmed}
              {c.capacity !== null ? ` af ${c.capacity}` : ""} pladser, {c.waiting} på venteliste
              {c.cancelledAt ? " · AFLYST" : ""}
            </div>
            {(signups.get(c.id) ?? []).length > 0 && (
              <ul className="people">
                {signups.get(c.id)!.map((s) => (
                  <li key={s.id} className="spread">
                    <span className="grow">
                      {s.firstName} {s.lastName}
                      <span className="muted small block">
                        {s.status === "waitlist" ? "Venteliste" : `${s.chargeStatus ? CHARGE[s.chargeStatus] : ""}${s.amountOre !== null ? ` · ${kr(s.amountOre)}` : ""}${s.discountPercent ? ` · søskenderabat ${s.discountPercent} %` : ""}`}
                      </span>
                    </span>
                    {!c.cancelledAt && (
                      <form action={cancelCampSignupAction}>
                        <input type="hidden" name="clubId" value={club.id} />
                        <input type="hidden" name="signupId" value={s.id} />
                        <button>Afmeld</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!c.cancelledAt && (
              <>
                <details>
                  <summary className="small">Ret camp</summary>
                  <form action={editCamp} className="stack">
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="campId" value={c.id} />
                    <Fields c={c} />
                    <p className="muted small">Ny pris og rabat gælder kun nye pladser. Flere pladser rykker folk op fra ventelisten.</p>
                    <button>Gem</button>
                  </form>
                </details>
                <form action={cancelCampAction}>
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="campId" value={c.id} />
                  <button>Aflys camp</button>
                </form>
              </>
            )}
          </li>
        ))}
      </ul>
      {camps.length === 0 && <p className="muted">Ingen camps endnu.</p>}
    </KasseShell>
  );
}
