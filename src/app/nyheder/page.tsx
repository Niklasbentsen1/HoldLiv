import Link from "next/link";
import { DEFAULT_BOARD_DAYS, listFeed, listPostTargets, MAX_BODY, MAX_BOARD_DAYS, MAX_TITLE } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
import { Avatar, Empty, PageHead } from "../../components/ui";
import { createPostAction, deletePostAction, pinPostAction, publicPostAction } from "../actions";

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" });

export default async function News({ searchParams }: { searchParams: Promise<{ fejl?: string; type?: string }> }) {
  const { fejl, type } = await searchParams;
  const board = type === "opslag";
  const kind = board ? "board" : "news";
  const back = board ? "/nyheder?type=opslag" : "/nyheder";
  const { ctx } = await requireSession(back);
  const [feed, targets] = await Promise.all([listFeed(db, ctx, kind), listPostTargets(db, ctx, kind)]);
  const anyLead = targets.some((t) => t.lead);

  return (
    <Shell active="/nyheder" ctx={ctx}>
      <PageHead
        title={board ? "Opslagstavle" : "Nyheder"}
        sub={board ? "Små opslag fra medlemmer og forældre: sælges, søges, fundet. De forsvinder af sig selv." : "Nyt fra foreningen og dine hold."}
      />
      <ErrorBox message={fejl} />
      <nav className="row" style={{ gap: 8, marginBottom: 16 }} aria-label="Vælg visning">
        <Link href="/nyheder" className={board ? "button" : "button primary"}>Nyheder</Link>
        <Link href="/nyheder?type=opslag" className={board ? "button primary" : "button"}>Opslagstavle</Link>
      </nav>

      <div className="team-layout">
        <div className="dash-main">
          {feed.length === 0 ? (
            <Empty icon="star">{board ? "Ingen opslag lige nu." : "Ingen nyheder endnu."}</Empty>
          ) : (
            feed.map((p) => (
              <article key={p.id} className="card stack" style={{ marginBottom: 14 }}>
                <div className="section-head">
                  <h2>{p.pinned ? "📌 " : ""}{p.title}</h2>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={p.authorName} size={28} />
                  <span className="muted small">
                    {p.authorName} · {p.scopeLabel} · {when.format(p.createdAt)}
                    {p.expiresAt ? ` · forsvinder ${when.format(p.expiresAt)}` : ""}
                  </span>
                </div>
                <p className="chat-text">{p.body}</p>
                {(p.canManage || p.mine) && (
                  <div className="actions">
                    {p.canManage && (
                      <form action={pinPostAction}>
                        <input type="hidden" name="postId" value={p.id} />
                        <input type="hidden" name="pinned" value={p.pinned ? "0" : "1"} />
                        <input type="hidden" name="back" value={back} />
                        <button className="button" type="submit">{p.pinned ? "Fjern fastgørelse" : "Fastgør"}</button>
                      </form>
                    )}
                    {p.canManage && p.kind === "news" && p.scopeKey.startsWith("club:") && (
                      <form action={publicPostAction}>
                        <input type="hidden" name="postId" value={p.id} />
                        <input type="hidden" name="public" value={p.publicOnSite ? "0" : "1"} />
                        <input type="hidden" name="back" value={back} />
                        <button className="button" type="submit">{p.publicOnSite ? "Fjern fra hjemmesiden" : "Vis på hjemmesiden"}</button>
                      </form>
                    )}
                    <form action={deletePostAction}>
                      <input type="hidden" name="postId" value={p.id} />
                      <input type="hidden" name="back" value={back} />
                      <button className="button danger" type="submit">Slet</button>
                    </form>
                  </div>
                )}
              </article>
            ))
          )}
        </div>

        <aside className="dash-side">
          {targets.length > 0 ? (
            <form action={createPostAction} className="card stack">
              <h2 className="section-head">{board ? "Nyt opslag" : "Ny nyhed"}</h2>
              <input type="hidden" name="kind" value={kind} />
              <label>
                {board ? "Hvor skal det hænge?" : "Til hvem?"}
                <select name="scope" required>
                  {targets.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Overskrift
                <input name="title" required maxLength={MAX_TITLE} />
              </label>
              <label>
                Tekst
                <textarea name="body" rows={5} required maxLength={MAX_BODY} />
              </label>
              {!board && anyLead && (
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" name="publicOnSite" style={{ width: "auto" }} /> Vis også på foreningens hjemmeside (kun for hele foreningen)
                </label>
              )}
              {board && (
                <label>
                  Hvor mange dage skal det hænge?
                  <input type="number" name="days" min={1} max={MAX_BOARD_DAYS} defaultValue={DEFAULT_BOARD_DAYS} />
                </label>
              )}
              {anyLead && (
                <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" name="pinned" style={{ width: "auto" }} /> Fastgør øverst (kun ledelsen)
                </label>
              )}
              <button className="button primary" type="submit">{board ? "Hæng op" : "Udgiv"}</button>
              {!board && <p className="muted small">Medlemmerne får besked, som de har valgt under Beskeder.</p>}
            </form>
          ) : (
            <section className="card">
              <p className="muted small">{board ? "Du hører ikke til nogen forening endnu." : "Kun ledelsen kan skrive nyheder."}</p>
            </section>
          )}
        </aside>
      </div>
    </Shell>
  );
}
