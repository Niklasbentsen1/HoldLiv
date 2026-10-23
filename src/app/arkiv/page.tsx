import { AUDIENCE_LABEL, listDocumentTargets, listDocuments } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { shortDay } from "../../lib/format";
import { ErrorBox, Shell } from "../../components/Shell";
import { Empty, PageHead } from "../../components/ui";
import { deleteDocumentAction, replaceDocumentAction, updateDocumentAction, uploadDocumentAction } from "../actions";

export const dynamic = "force-dynamic";

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);

export default async function Arkiv({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/arkiv");
  const [docs, targets] = await Promise.all([listDocuments(db, ctx), listDocumentTargets(db, ctx)]);
  const groups = new Map<string, typeof docs>();
  for (const d of docs) groups.set(d.category ?? "Øvrige", [...(groups.get(d.category ?? "Øvrige") ?? []), d]);
  const canUpload = targets.clubs.length > 0 || targets.teams.length > 0;

  return (
    <Shell ctx={ctx} active="/arkiv">
      <PageHead title="Dokumentarkiv" sub="Vedtægter, referater, regler og budgetter samlet ét sted." />
      <ErrorBox message={fejl} />

      {canUpload && (
        <details className="card">
          <summary className="title">Læg et dokument op</summary>
          <form action={uploadDocumentAction} className="stack">
            <label>
              Til
              <select name="target">
                {targets.clubs.map((c) => (
                  <option key={`club:${c.id}`} value={`club:${c.id}`}>
                    Hele {c.name}
                  </option>
                ))}
                {targets.clubs.map((c) => (
                  <option key={`board:${c.id}`} value={`board:${c.id}`}>
                    Bestyrelsen og kassereren i {c.name}
                  </option>
                ))}
                {targets.teams.map((t) => (
                  <option key={t.id} value={`team:${t.clubId}:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Titel
              <input name="title" required maxLength={120} placeholder="Fx Vedtægter 2026" />
            </label>
            <div className="row">
              <label>
                Mappe <span className="muted">(valgfri)</span>
                <input name="category" maxLength={40} placeholder="Fx Referater" list="kategorier" />
                <datalist id="kategorier">
                  {[...groups.keys()].filter((k) => k !== "Øvrige").map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
              </label>
              <label>
                Uddybning <span className="muted">(valgfri)</span>
                <input name="description" />
              </label>
            </div>
            <label>
              Fil <span className="muted">(PDF, billede, Word eller Excel, højst 10 MB)</span>
              <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx" />
            </label>
            <button className="primary">Læg op</button>
          </form>
        </details>
      )}

      {docs.length === 0 && <Empty icon="star">Der er ingen dokumenter endnu.</Empty>}
      {[...groups.entries()].map(([name, list]) => (
        <section key={name}>
          <h2>{name}</h2>
          <ul className="events">
            {list.map((d) => (
              <li key={d.id} className="card stack">
                <span className="spread">
                  <span className="grow">
                    <a href={`/arkiv/${d.id}/hent`} className="title">
                      {d.title}
                    </a>
                    <span className="muted small block">
                      {d.fileName} · {size(d.size)} · version {d.version} · {shortDay(d.updatedAt)} · {d.audience === "team" ? d.teamName : AUDIENCE_LABEL[d.audience]}
                    </span>
                    {d.description && <span className="muted small block">{d.description}</span>}
                  </span>
                </span>
                {d.canManage && (
                  <details>
                    <summary className="small">Ret, ny version eller slet</summary>
                    <form action={updateDocumentAction} className="stack">
                      <input type="hidden" name="documentId" value={d.id} />
                      <input name="title" defaultValue={d.title} required maxLength={120} />
                      <input name="category" defaultValue={d.category ?? ""} maxLength={40} placeholder="Mappe" />
                      <input name="description" defaultValue={d.description ?? ""} placeholder="Uddybning" />
                      <button>Gem</button>
                    </form>
                    <form action={replaceDocumentAction} className="stack">
                      <input type="hidden" name="documentId" value={d.id} />
                      <input type="file" name="file" required accept=".pdf,.jpg,.jpeg,.png,.webp,.docx,.xlsx" />
                      <button>Erstat med ny version</button>
                    </form>
                    <form action={deleteDocumentAction}>
                      <input type="hidden" name="documentId" value={d.id} />
                      <button className="link small">Slet dokumentet</button>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Shell>
  );
}
