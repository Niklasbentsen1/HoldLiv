import { notFound } from "next/navigation";
import { checkTicket } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { ForbiddenError } from "../../../auth/permissions";
import { ErrorBox, Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { when } from "../../../lib/format";
import { admitTicketAction } from "../../actions";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

const STATUS = {
  valid: { text: "Gyldig billet", cls: "pill brand" },
  used: { text: "Allerede brugt", cls: "pill cancel" },
  void: { text: "Ikke gyldig (refunderet)", cls: "pill cancel" },
  cancelled: { text: "Arrangementet er aflyst", cls: "pill cancel" },
} as const;

/** Det den, der står i indgangen, ser, når en billets QR-kode scannes. Kræver login som admin, kasserer eller træner i foreningen. */
export default async function Ticket({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { code } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/billet/${code}`);
  let check;
  try {
    check = await checkTicket(db, ctx, code);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return (
        <Shell ctx={ctx}>
          <PageHead title="Billet" />
          <p className="error">Kun administratorer, kassereren og trænere i foreningen kan scanne billetter.</p>
        </Shell>
      );
    }
    throw e;
  }
  if (!check.found) notFound();
  const s = STATUS[check.status];

  return (
    <Shell ctx={ctx}>
      <PageHead title="Billet" sub={check.clubName} />
      <ErrorBox message={fejl} />
      <section className="card stack" style={{ maxWidth: 420 }}>
        <span className={s.cls} style={{ alignSelf: "flex-start", fontSize: 18 }}>
          {s.text}
        </span>
        <strong style={{ fontSize: 24 }}>{check.event}</strong>
        <span className="muted">{when(check.startsAt)}</span>
        <span className="muted small">
          Billet {check.number} af {check.of} i bestillingen
        </span>
        {check.usedAt && <span className="muted small">Brugt {when(check.usedAt)}</span>}
        {check.status === "valid" && (
          <form action={admitTicketAction}>
            <input type="hidden" name="code" value={code} />
            <button className="primary">Slip ind</button>
          </form>
        )}
      </section>
    </Shell>
  );
}
