import Link from "next/link";
import { getCheckout } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr } from "../../../lib/money";
import { Shell } from "../../../components/Shell";

export const dynamic = "force-dynamic";

export default async function Receipt({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session } = await searchParams;
  const { ctx } = await requireSession("/betaling");
  const c = session ? await getCheckout(db, ctx, session).catch(() => null) : null;
  if (!c) return <Shell ctx={ctx}>Betalingen blev ikke fundet.</Shell>;

  return (
    <Shell ctx={ctx} active="/betaling">
      <section className="card checkout">
        {c.status === "succeeded" ? (
          <>
            <h1 className="flush">Tak for betalingen</h1>
            <p className="big">{kr(c.amountOre)}</p>
            <p>
              {c.description} for {c.firstName} er betalt til {c.clubName}.
            </p>
          </>
        ) : (
          <>
            <h1 className="flush">Betalingen behandles</h1>
            <p>Vi venter på bekræftelse. Det tager som regel få sekunder. Opdater siden om lidt.</p>
          </>
        )}
        <p>
          <Link href="/betaling">Tilbage til betalinger</Link>
        </p>
      </section>
    </Shell>
  );
}
