import { users, profiles } from "../db/schema";
import { eq } from "drizzle-orm";
import { loadActingProfiles } from "../auth/context";
import { describeRoles, listUpcomingEvents } from "../services";
import { db } from "../lib/db";
import { getSession } from "../lib/session";
import { demoLogin, logout, respond, switchProfile } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_LABEL = { training: "Træning", match: "Kamp", other: "Aktivitet" } as const;
const STATUS = [
  { value: "yes", label: "Kommer" },
  { value: "maybe", label: "Måske" },
  { value: "no", label: "Kommer ikke" },
] as const;

const when = (d: Date) =>
  d.toLocaleString("da-DK", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });

export default async function Home() {
  const session = await getSession();
  if (!session) return <Login />;

  const { ctx, actingProfileId } = session;
  const [acting, roles, upcoming] = await Promise.all([
    loadActingProfiles(db, ctx),
    describeRoles(db, ctx),
    listUpcomingEvents(db, ctx, actingProfileId),
  ]);
  const me = acting.find((p) => p.isSelf)!;
  const current = acting.find((p) => p.id === actingProfileId)!;

  return (
    <main>
      <header>
        <strong className="logo">HoldLiv</strong>
        <form action={logout}>
          <button className="link">Log ud ({me.firstName})</button>
        </form>
      </header>

      {acting.length > 1 && (
        <section>
          <h2>Agér som</h2>
          <div className="chips">
            {acting.map((p) => (
              <form key={p.id} action={switchProfile}>
                <input type="hidden" name="profileId" value={p.id} />
                <button className={p.id === actingProfileId ? "chip active" : "chip"}>
                  {p.firstName} {p.isSelf ? "(mig)" : ""}
                </button>
              </form>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>{current.isSelf ? "Mine aktiviteter" : `${current.firstName}s aktiviteter`}</h2>
        {upcoming.length === 0 && <p className="muted">Ingen kommende aktiviteter.</p>}
        <ul className="events">
          {upcoming.map((e) => (
            <li key={e.id} className="card">
              <div className="meta">
                <span className={`tag ${e.type}`}>{TYPE_LABEL[e.type]}</span> {e.teamName}
              </div>
              <div className="title">{e.title}</div>
              <div className="muted">
                {when(e.startsAt)}
                {e.location ? ` · ${e.location}` : ""}
              </div>
              <div className="answers">
                {STATUS.map((s) => (
                  <form key={s.value} action={respond}>
                    <input type="hidden" name="eventId" value={e.id} />
                    <input type="hidden" name="status" value={s.value} />
                    <button className={e.status === s.value ? `answer ${s.value} active` : "answer"}>{s.label}</button>
                  </form>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Mine roller</h2>
        <ul className="roles">
          {roles.map((r) => (
            <li key={r.label} className={`role ${r.kind}`}>
              {r.label}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

async function Login() {
  const people = await db
    .select({ id: users.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .orderBy(profiles.firstName);
  return (
    <main>
      <header>
        <strong className="logo">HoldLiv</strong>
      </header>
      <section>
        <h2>Demo-login</h2>
        <p className="muted">Vælg en person fra demodata. Rigtigt login kommer senere.</p>
        <div className="chips">
          {people.map((p) => (
            <form key={p.id} action={demoLogin}>
              <input type="hidden" name="userId" value={p.id} />
              <button className="chip">
                {p.firstName} {p.lastName}
              </button>
            </form>
          ))}
        </div>
      </section>
    </main>
  );
}
