import Link from "next/link";
import { listFees, listMembers, type MemberFilter } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { addDays, kr, localDate } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { singleCharge, updateMember } from "../../actions";

export const dynamic = "force-dynamic";

const FILTERS: { key: MemberFilter; label: string }[] = [
  { key: "active", label: "Aktive" },
  { key: "no_fee", label: "Mangler kontingent" },
  { key: "overdue", label: "I restance" },
  { key: "exempt", label: "Gratister" },
  { key: "inactive", label: "Udmeldte" },
  { key: "all", label: "Alle" },
];

const age = (birthDate: string | null, today: string) => {
  if (!birthDate) return null;
  const a = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return today.slice(5) < birthDate.slice(5) ? a - 1 : a;
};

export default async function Members({ searchParams }: { searchParams: Promise<{ klub?: string; vis?: string; q?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/medlemmer");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const filter = (FILTERS.find((f) => f.key === p.vis)?.key ?? "active") as MemberFilter;
  const [members, { fees }] = await Promise.all([listMembers(db, ctx, club.id, { filter, q: p.q }), listFees(db, ctx, club.id)]);
  const activeFees = fees.filter((f) => !f.archivedAt);
  const today = localDate(ctx.now);
  const back = `/kasse/medlemmer?klub=${club.id}&vis=${filter}${p.q ? `&q=${encodeURIComponent(p.q)}` : ""}`;

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/medlemmer">
      <ErrorBox message={p.fejl} />
      <div className="chips">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/kasse/medlemmer?klub=${club.id}&vis=${f.key}`} className={f.key === filter ? "chip active" : "chip"}>
            {f.label}
          </Link>
        ))}
      </div>
      <form className="inline">
        <input type="hidden" name="klub" value={club.id} />
        <input type="hidden" name="vis" value={filter} />
        <input name="q" defaultValue={p.q} placeholder="Søg på navn, e-mail eller forælder" />
        <button>Søg</button>
      </form>
      <p className="muted small spread">
        <span>{members.length} medlemmer</span>
        <a href={`/kasse/medlemmer/eksport?klub=${club.id}`}>Hent som regneark (CSV)</a>
      </p>

      <ul className="events compact">
        {members.map((m) => (
          <li key={m.profileId} className="card stack">
            <div className="spread">
              <span>
                <strong>
                  {m.firstName} {m.lastName}
                </strong>{" "}
                {m.birthDate && <span className="muted">{age(m.birthDate, today)} år</span>}
              </span>
              {m.openOre > 0 && <span className={m.overdue ? "tag overdue" : "tag open"}>Skylder {kr(m.openOre)}</span>}
            </div>
            <div className="small">
              {m.status !== "active" ? (
                <span className="muted">Udmeldt</span>
              ) : m.exempt ? (
                "Gratist"
              ) : m.feeName ? (
                m.feeName
              ) : (
                <span className="tag overdue">Mangler kontingent</span>
              )}
              {m.teams.length > 0 && <span className="muted"> · {m.teams.join(", ")}</span>}
            </div>
            {m.guardians.length > 0 && (
              <div className="muted small">
                Forældre: {m.guardians.map((g) => `${g.firstName} ${g.lastName}${g.phone ? ` (${g.phone})` : ""}`).join(", ")}
              </div>
            )}
            {!m.minor && (m.email || m.phone) && <div className="muted small">{[m.email, m.phone].filter(Boolean).join(" · ")}</div>}
            <details>
              <summary className="small">Ret medlemskab</summary>
              <form action={updateMember} className="stack">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="profileId" value={m.profileId} />
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="exemptField" value="1" />
                <label>
                  Kontingent
                  <select name="feeId" defaultValue={m.feeId ?? ""}>
                    <option value="">Intet kontingent</option>
                    {activeFees.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({kr(f.amountOre)})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" name="exempt" defaultChecked={m.exempt} /> Gratist (træner, frivillig eller pause)
                </label>
                <button>Gem</button>
              </form>
              <form action={updateMember} className="actions">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="profileId" value={m.profileId} />
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="status" value={m.status === "active" ? "inactive" : "active"} />
                <button className={m.status === "active" ? "danger" : undefined}>{m.status === "active" ? "Meld ud" : "Meld ind igen"}</button>
              </form>
              <form action={singleCharge} className="stack">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="profileId" value={m.profileId} />
                <input type="hidden" name="back" value={back} />
                <strong className="small">Ekstra opkrævning</strong>
                <input name="description" placeholder="Fx stævne i marts eller træningstrøje" required />
                <div className="row">
                  <label>
                    Beløb (kr.)
                    <input name="amount" inputMode="decimal" required />
                  </label>
                  <label>
                    Frist
                    <input name="dueDate" type="date" defaultValue={addDays(today, 14)} required />
                  </label>
                </div>
                <button>Opkræv</button>
              </form>
            </details>
          </li>
        ))}
      </ul>
    </KasseShell>
  );
}
