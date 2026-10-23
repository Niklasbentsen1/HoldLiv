import { notFound } from "next/navigation";
import { checkCard } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { ForbiddenError } from "../../../auth/permissions";
import { Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

/** Det en træner, kassereren eller admin ser, når de scanner et medlemskort. */
export default async function Check({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { ctx } = await requireSession(`/tjek/${token}`);
  let check;
  try {
    check = await checkCard(db, ctx, token);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return (
        <Shell ctx={ctx}>
          <PageHead title="Medlemskort" />
          <p className="error">Kun administratorer, kassereren og trænere i foreningen kan kontrollere medlemskort.</p>
        </Shell>
      );
    }
    throw e;
  }
  if (!check.found) notFound();

  return (
    <Shell ctx={ctx}>
      <PageHead title="Medlemskort" sub={check.clubName} />
      <section className="card stack" style={{ maxWidth: 420 }}>
        <span className={check.valid ? "pill brand" : "pill cancel"} style={{ alignSelf: "flex-start", fontSize: 18 }}>
          {check.valid ? "Gyldigt medlemskab" : "Ikke gyldigt"}
        </span>
        <strong style={{ fontSize: 28 }}>{check.name}</strong>
        {check.teams.length > 0 && <span className="muted">{check.teams.join(", ")}</span>}
        {check.overdue === true && <span className="pill cancel" style={{ alignSelf: "flex-start" }}>Har en forfalden opkrævning</span>}
        {check.overdue === false && <span className="muted small">Ingen forfaldne opkrævninger.</span>}
      </section>
    </Shell>
  );
}
