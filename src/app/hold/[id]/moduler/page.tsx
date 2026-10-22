import Link from "next/link";
import { getTeam, listTeamModules } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { saveModuleConfig } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function TeamModules({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/moduler`);
  const team = await getTeam(db, ctx, id);
  const modules = await listTeamModules(db, ctx, id);

  return (
    <Shell ctx={ctx}>
      <h1>Moduler</h1>
      <p className="muted">
        <Link href={`/hold/${id}`}>{team.name}</Link> · {team.clubName}
      </p>
      <ErrorBox message={fejl} />
      {!team.canManage && <p className="muted">Kun trænere og administratorer ændrer indstillinger.</p>}
      <ul className="stack">
        {modules.map((m) => (
          <li key={m.key} className="card stack">
            <div className="spread">
              <strong>{m.name}</strong>
              <span className={m.enabled ? "tag paid" : "tag"}>{m.enabled ? "Slået til" : m.available ? "Slået fra" : "Kommer snart"}</span>
            </div>
            <p className="muted small">{m.description}</p>
            {m.enabled && m.fields.length > 0 && (
              <form action={saveModuleConfig} className="stack">
                <input type="hidden" name="teamId" value={id} />
                <input type="hidden" name="module" value={m.key} />
                {m.fields.map((f) =>
                  f.type === "int" ? (
                    <label key={f.key}>
                      {f.label}
                      <input type="number" name={f.key} min={f.min} max={f.max} defaultValue={Number(m.config[f.key])} disabled={!team.canManage} />
                      {f.hint && <span className="muted small">{f.hint}</span>}
                    </label>
                  ) : (
                    <label key={f.key} className="check">
                      <input type="checkbox" name={f.key} defaultChecked={!!m.config[f.key]} disabled={!team.canManage} /> {f.label}
                    </label>
                  ),
                )}
                {team.canManage && <button className="primary">Gem indstillinger</button>}
              </form>
            )}
          </li>
        ))}
      </ul>
      <p className="muted small">Foreningens administratorer slår moduler til og fra under Forening.</p>
    </Shell>
  );
}
