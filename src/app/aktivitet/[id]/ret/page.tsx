import { getEventDetail } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { PageHead } from "../../../../components/ui";
import { EventFields } from "../../../../components/EventFields";
import { editEvent } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function EditEvent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/aktivitet/${id}/ret`);
  const e = await getEventDetail(db, ctx, id);
  if (!e.canManage) return <Shell>Kun holdets trænere kan rette aktiviteter.</Shell>;
  return (
    <Shell admin={ctx.adminClubs.size > 0}>
      <PageHead back={{ href: `/aktivitet/${id}`, label: e.title }} title="Ret aktivitet" />
      <ErrorBox message={fejl} />
      <form action={editEvent} className="card stack" style={{ maxWidth: 640 }}>
        <input type="hidden" name="eventId" value={id} />
        <EventFields defaults={e} />
        {e.seriesId && <p className="muted small">Ændringen gælder kun denne dato, ikke resten af serien.</p>}
        <button className="primary">Gem</button>
      </form>
    </Shell>
  );
}
