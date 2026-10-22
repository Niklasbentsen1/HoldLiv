import Link from "next/link";
import { AUDIT_LABELS, listAudit } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";

export const dynamic = "force-dynamic";

const when = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ klub?: string; for?: string }> }) {
  const { klub, for: before } = await searchParams;
  const { ctx } = await requireSession(`/forening/log?klub=${klub ?? ""}`);
  if (!klub) return <Shell ctx={ctx}>Vælg en forening.</Shell>;
  const date = before ? new Date(before) : undefined;
  const { rows, more } = await listAudit(db, ctx, klub, date && !Number.isNaN(date.getTime()) ? date : undefined);
  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead title="Aktivitetslog" sub="Hvem har gjort hvad: roller, medlemmer, økonomi og login. Loggen kan ikke redigeres." />
      {rows.length === 0 ? (
        <Empty>Ingen aktivitet endnu.</Empty>
      ) : (
        <ul className="stack">
          {rows.map((r) => (
            <li key={r.id} className="card">
              <strong>{AUDIT_LABELS[r.action] ?? r.action}</strong>
              <span className="muted small block">
                {r.actorName ?? r.actorEmail ?? "Ukendt"} · {when.format(r.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {more && <Link href={`/forening/log?klub=${klub}&for=${rows[rows.length - 1].at.toISOString()}`} className="button">Ældre</Link>}
    </Shell>
  );
}
