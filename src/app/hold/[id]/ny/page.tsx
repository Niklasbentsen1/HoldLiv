import { getTeam } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { PageHead } from "../../../../components/ui";
import { EventFields } from "../../../../components/EventFields";
import { newEvent } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function NewEvent({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/ny`);
  const team = await getTeam(db, ctx, id);
  if (!team.canManage) return <Shell>Kun holdets trænere kan oprette aktiviteter.</Shell>;

  return (
    <Shell admin={ctx.adminClubs.size > 0}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Ny aktivitet" />
      <ErrorBox message={fejl} />
      <form action={newEvent} className="card stack" style={{ maxWidth: 640 }}>
        <input type="hidden" name="teamId" value={id} />
        <EventFields />
        <label>
          Gentag hver uge til og med <span className="muted">(valgfri)</span>
          <input type="date" name="repeatUntil" />
        </label>
        <p className="muted small">Med en slutdato oprettes en fast ugentlig aktivitet på samme ugedag og klokkeslæt, højst 52 uger.</p>
        <button className="primary">Opret</button>
      </form>
    </Shell>
  );
}
