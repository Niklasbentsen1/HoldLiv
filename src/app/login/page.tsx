import Link from "next/link";
import { eq } from "drizzle-orm";
import { profiles, users } from "../../db/schema";
import { db } from "../../lib/db";
import { safeNext } from "../../lib/session";
import { Bare, ErrorBox } from "../../components/Shell";
import { Avatar } from "../../components/ui";
import { demoLogin, requestLoginAction } from "../actions";

export const dynamic = "force-dynamic";

const demoEnabled = () => process.env.NODE_ENV !== "production" || process.env.DEMO_LOGIN === "1";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; fejl?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const people = demoEnabled()
    ? await db
        .select({ id: users.id, firstName: profiles.firstName, lastName: profiles.lastName, email: users.email })
        .from(users)
        .innerJoin(profiles, eq(profiles.userId, users.id))
        .orderBy(profiles.firstName)
    : [];
  const demo = people.filter((p) => p.email.endsWith("@holdliv.test"));

  return (
    <Bare>
      <section className="card stack">
        <h1>Log ind</h1>
        <p className="muted">Skriv din e-mail. Vi sender en kode, så du ikke skal huske et kodeord.</p>
        <ErrorBox message={sp.fejl} />
        <form action={requestLoginAction} className="stack">
          <input type="hidden" name="next" value={next} />
          <label>
            E-mail
            <input type="email" name="email" required autoComplete="email" inputMode="email" placeholder="navn@eksempel.dk" />
          </label>
          <button className="primary">Send kode</button>
        </form>
        <p className="muted small">Første gang du logger ind, opretter vi dig. Børn har ikke eget login; dem styrer du som forælder.</p>
        <p className="muted small">Skal jeres forening på HoldLiv? <Link href="/login?next=/opret-forening">Opret den her</Link>.</p>
      </section>

      {demo.length > 0 && (
        <section className="demo">
          <div>
            <h2>Prøv demoen</h2>
            <p className="muted small">Log ind som en af medlemmerne i Skovby IF, en opdigtet forening.</p>
          </div>
          <div className="chips">
            {demo.map((p) => (
              <form key={p.id} action={demoLogin}>
                <input type="hidden" name="userId" value={p.id} />
                <button className="chip">
                  <Avatar name={`${p.firstName} ${p.lastName}`} size={28} />
                  {p.firstName} {p.lastName}
                </button>
              </form>
            ))}
          </div>
        </section>
      )}
    </Bare>
  );
}
