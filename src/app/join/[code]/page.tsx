import { loadActingProfiles } from "../../../auth/context";
import { findTeamByInvite, teamSpots } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { Shell, ErrorBox } from "../../../components/Shell";
import Link from "next/link";
import { Crest } from "../../../components/ui";
import { joinTeam } from "../../actions";

export const dynamic = "force-dynamic";

export default async function Join({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { code } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/join/${code}`);
  const team = await findTeamByInvite(db, code);
  if (!team)
    return (
      <Shell ctx={ctx}>
        <h1>Linket virker ikke</h1>
        <p className="muted">Invitationen er udløbet eller er blevet erstattet af en ny. Bed træneren om holdets nye link.</p>
      </Shell>
    );
  const acting = await loadActingProfiles(db, ctx);
  const spots = await teamSpots(db, team.id);
  const queue = spots.full || spots.waiting > 0;

  return (
    <Shell ctx={ctx}>
      <section className="card stack" style={{ maxWidth: 520, margin: "0 auto" }}>
        <Crest name={team.name} size={56} />
        <p className="muted small">Invitation til</p>
        <h1 className="flush">{team.name}</h1>
        <p className="muted">
          {team.clubName}
          {team.season ? ` · ${team.season}` : ""}
        </p>
        <ErrorBox message={fejl} />
        <form action={joinTeam} className="stack">
          <input type="hidden" name="code" value={code} />
          {queue && <p className="pill">{spots.full ? "Holdet er fuldt." : "Der er allerede nogen på ventelisten."} Du kommer på ventelisten og får besked, når der bliver en plads.</p>}
          <p>Hvem skal være med på holdet?</p>
          {acting.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" name="profileId" value={p.id} defaultChecked={!p.isSelf && acting.length === 2} />
              {p.firstName} {p.lastName} {p.isSelf ? "(mig selv)" : ""}
            </label>
          ))}
          <button className="primary">{queue ? "Sæt på ventelisten" : "Meld på holdet"}</button>
        </form>
        {acting.length === 1 && (
          <p className="muted small">
            Er det dit barn, der skal spille? <Link href="/familie">Tilføj barnet under Familie</Link> og åbn linket igen.
          </p>
        )}
      </section>
    </Shell>
  );
}
