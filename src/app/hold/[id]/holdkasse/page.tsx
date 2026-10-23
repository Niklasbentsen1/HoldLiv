import { getTeam, getTeamFund } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { kr, localDate, longDate } from "../../../../lib/money";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Empty, PageHead, Stat } from "../../../../components/ui";
import { addFundEntryAction, cancelFundEntryAction } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function TeamFund({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/holdkasse`);
  const team = await getTeam(db, ctx, id);
  const f = await getTeamFund(db, ctx, id);

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Holdkasse" sub="Holdets egen kasse. Trænerne bogfører; hele holdet kan se saldo og poster." />
      <ErrorBox message={fejl} />

      <div className="tiles" style={{ marginBottom: 20 }}>
        <Stat label="I kassen" value={kr(f.balanceOre)} icon="coins" hint="saldo" />
        <Stat label="Indbetalt" value={kr(f.depositedOre)} icon="star" hint="i alt" />
        <Stat label="Brugt" value={kr(f.spentOre)} icon="clock" hint="i alt" />
      </div>

      <div className="team-layout">
        <div className="dash-main">
          <section className="section">
            <div className="section-head">
              <h2>Poster</h2>
            </div>
            {f.entries.length === 0 && <Empty icon="coins">Der er ingen poster endnu.</Empty>}
            <ul className="people">
              {f.entries.map((e) => (
                <li key={e.id} className={e.cancelled ? "cancelled" : undefined}>
                  <span className="grow">
                    <span className={e.cancelled ? "name strike" : "name"}>{e.description}</span>
                    <span className="note">
                      {longDate(e.entryDate)}
                      {e.payerName ? ` · ${e.payerName}` : ""}
                      {e.cancelled ? " · annulleret" : ""}
                    </span>
                  </span>
                  <span className={e.kind === "deposit" ? "pill brand" : "pill"}>
                    {e.kind === "deposit" ? "+" : "−"} {kr(e.amountOre)}
                  </span>
                  {f.canManage && !e.cancelled && (
                    <form action={cancelFundEntryAction}>
                      <input type="hidden" name="teamId" value={id} />
                      <input type="hidden" name="entryId" value={e.id} />
                      <button className="link small">Annuller</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>

        {f.canManage && (
          <aside className="dash-side">
            <section className="card stack">
              <strong>Ny post</strong>
              <form action={addFundEntryAction} className="stack">
                <input type="hidden" name="teamId" value={id} />
                <label>
                  Type
                  <select name="kind" defaultValue="deposit">
                    <option value="deposit">Indbetaling</option>
                    <option value="withdrawal">Udgift</option>
                  </select>
                </label>
                <label>
                  Beløb i kr.
                  <input name="amount" required inputMode="decimal" placeholder="Fx 50" />
                </label>
                <label>
                  Hvad
                  <input name="description" required maxLength={200} placeholder="Fx pizza til sæsonafslutning" />
                </label>
                <label>
                  Dato
                  <input type="date" name="entryDate" max={localDate(ctx.now)} defaultValue={localDate(ctx.now)} />
                </label>
                <label>
                  Indbetalt af <span className="muted">(valgfrit, kun trænere ser navnet)</span>
                  <select name="profileId" defaultValue="">
                    <option value="">Ingen</option>
                    {f.players.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="primary">Bogfør</button>
              </form>
            </section>
          </aside>
        )}
      </div>
    </Shell>
  );
}
