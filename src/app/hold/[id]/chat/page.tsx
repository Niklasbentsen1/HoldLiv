import Link from "next/link";
import { getChat, getEventChat, getTeam, listChats, MAX_MESSAGE_LENGTH } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { AutoRefresh } from "../../../../components/AutoRefresh";
import { Avatar, Empty, PageHead } from "../../../../components/ui";
import { deleteChatMessageAction, postChatMessageAction } from "../../../actions";

export const dynamic = "force-dynamic";

const stamp = new Intl.DateTimeFormat("da-DK", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });

export default async function TeamChat({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fejl?: string; samtale?: string; aktivitet?: string }>;
}) {
  const { id } = await params;
  const { fejl, samtale, aktivitet } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/chat`);
  const team = await getTeam(db, ctx, id);
  const chats = await listChats(db, ctx, id);
  const wanted = aktivitet ? await getEventChat(db, ctx, aktivitet) : (samtale ?? chats[0]?.id);
  const chat = wanted ? await getChat(db, ctx, wanted) : null;

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Holdchat" sub="Grupperne følger holdet automatisk. Børn har ikke adgang." />
      <ErrorBox message={fejl} />
      <AutoRefresh />
      <div className="team-layout">
        <div className="dash-main">
          {chat ? (
            <section className="card stack chat">
              <div className="section-head">
                <h2>{chat.name}</h2>
                {chat.eventId && <Link href={`/aktivitet/${chat.eventId}`}>Se aktiviteten</Link>}
              </div>
              {chat.messages.length === 0 ? (
                <Empty icon="bell">Ingen beskeder endnu. Skriv den første.</Empty>
              ) : (
                <ul className="chat-list">
                  {chat.messages.map((m) => (
                    <li key={m.id} className={m.mine ? "chat-msg mine" : "chat-msg"}>
                      <Avatar name={m.authorName} size={32} />
                      <div className="chat-bubble">
                        <div className="chat-meta">
                          <strong>{m.authorName}</strong>
                          {m.authorLabel && <span className="muted small"> · {m.authorLabel}</span>}
                          <span className="muted small"> · {stamp.format(m.createdAt)}</span>
                        </div>
                        {m.deleted ? <p className="muted">Beskeden er slettet.</p> : <p className="chat-text">{m.body}</p>}
                        {m.canDelete && (
                          <form action={deleteChatMessageAction}>
                            <input type="hidden" name="teamId" value={id} />
                            <input type="hidden" name="threadId" value={chat.id} />
                            <input type="hidden" name="messageId" value={m.id} />
                            <button className="link-button small muted" type="submit">Slet</button>
                          </form>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <form action={postChatMessageAction} className="stack chat-form">
                <input type="hidden" name="teamId" value={id} />
                <input type="hidden" name="threadId" value={chat.id} />
                <textarea name="body" rows={3} maxLength={MAX_MESSAGE_LENGTH} required placeholder="Skriv en besked" aria-label="Besked" />
                <button className="button primary" type="submit">Send</button>
              </form>
            </section>
          ) : (
            <Empty icon="bell">Du har ikke adgang til nogen samtaler på holdet.</Empty>
          )}
        </div>
        <aside className="dash-side">
          <section className="card stack">
            <h2 className="section-head">Samtaler</h2>
            <ul className="people">
              {chats.map((c) => (
                <li key={c.id}>
                  <Link href={`/hold/${id}/chat?samtale=${c.id}`} className="grow chat-link">
                    <span className="name">{c.name}</span>
                    <span className="note">{c.lastText ? c.lastText.slice(0, 60) : c.about}</span>
                  </Link>
                  {c.unread > 0 && <span className="pill">{c.unread}</span>}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
