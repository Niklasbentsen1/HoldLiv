import Link from "next/link";
import { readDevOutbox } from "../../../lib/mail";
import { safeNext } from "../../../lib/session";
import { Bare, ErrorBox } from "../../../components/Shell";
import { verifyCodeAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function CodePage({ searchParams }: { searchParams: Promise<{ email?: string; next?: string; fejl?: string }> }) {
  const sp = await searchParams;
  const email = sp.email ?? "";
  const next = safeNext(sp.next);
  const dev = readDevOutbox(email);
  return (
    <Bare>
      <section className="card stack">
        <h1>Tjek din mail</h1>
        <p className="muted">
          Vi har sendt en kode til <strong>{email}</strong>. Skriv den her, eller tryk på linket i mailen.
        </p>
        <ErrorBox message={sp.fejl} />
        <form action={verifyCodeAction} className="stack">
          <input type="hidden" name="email" value={email} />
          <input type="hidden" name="next" value={next} />
          <label>
            Kode
            <input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" placeholder="123456" className="code" autoFocus />
          </label>
          <button className="primary">Log ind</button>
        </form>
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="muted small">
          Ingen mail? Prøv igen
        </Link>
      </section>
      {dev && (
        <section className="card dev">
          <strong>Udviklingstilstand:</strong> der er ikke sat en mailudbyder op, så her er mailen.
          <br />
          Kode: <code>{dev.code}</code> · <a href={dev.link}>Log ind med linket</a>
        </section>
      )}
    </Bare>
  );
}
