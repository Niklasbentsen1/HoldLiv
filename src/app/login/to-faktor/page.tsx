import { redirect } from "next/navigation";
import { Bare, ErrorBox } from "../../../components/Shell";
import { safeNext, sessionAwaitsMfa } from "../../../lib/session";
import { completeMfaAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function MfaLogin({ searchParams }: { searchParams: Promise<{ next?: string; fejl?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (!(await sessionAwaitsMfa())) redirect(`/login?next=${encodeURIComponent(next)}`);
  return (
    <Bare>
      <section className="card stack">
        <h1>To-faktor</h1>
        <p className="muted">Skriv den 6-cifrede kode fra din autentificeringsapp. Har du mistet din telefon, kan du bruge en af dine nødkoder.</p>
        <ErrorBox message={sp.fejl} />
        <form action={completeMfaAction} className="stack">
          <input type="hidden" name="next" value={next} />
          <label>
            Kode
            <input name="code" required autoComplete="one-time-code" placeholder="123456" className="code" autoFocus />
          </label>
          <button className="primary">Log ind</button>
        </form>
      </section>
    </Bare>
  );
}
