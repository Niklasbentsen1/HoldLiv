import { getNotificationPrefs, listMyNotifications } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { CHANNELS, CHANNEL_LABEL, KINDS } from "../../lib/notify";
import { Shell, ErrorBox } from "../../components/Shell";
import { Empty, PageHead } from "../../components/ui";
import { saveNotificationPrefs } from "../actions";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { pending: "Venter", sent: "Sendt", failed: "Fejlede", skipped: "Sprunget over" };
const when = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Copenhagen" });

export default async function Settings({ searchParams }: { searchParams: Promise<{ fejl?: string; gemt?: string }> }) {
  const { fejl, gemt } = await searchParams;
  const { ctx } = await requireSession("/indstillinger");
  const [{ prefs, phone }, recent] = await Promise.all([getNotificationPrefs(db, ctx.userId), listMyNotifications(db, ctx)]);

  return (
    <Shell active="/indstillinger" ctx={ctx}>
      <PageHead title="Beskeder" sub="Vælg, hvordan du vil have besked om ændringer og aflysninger. Du får også beskeder om dine børn." />
      <ErrorBox message={fejl} />
      {gemt && <p className="pill">Gemt</p>}
      <form action={saveNotificationPrefs} className="card stack" style={{ marginBottom: 20 }}>
        <label className="field">
          <span>Mobilnummer (til SMS)</span>
          <input name="phone" type="tel" defaultValue={phone ?? ""} placeholder="20 12 34 56" autoComplete="tel" />
        </label>
        {Object.entries(KINDS).map(([kind, def]) => (
          <fieldset key={kind} className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>{def.label}</strong></legend>
            <span className="muted small">{def.description}</span>
            {CHANNELS.map((channel) => (
              <label key={channel} className="row" style={{ gap: 8 }}>
                <input type="checkbox" name={`${kind}:${channel}`} defaultChecked={prefs[kind as keyof typeof prefs][channel]} />
                {CHANNEL_LABEL[channel]}
              </label>
            ))}
          </fieldset>
        ))}
        <button className="btn primary" type="submit">Gem</button>
      </form>
      <section className="card stack">
        <h2 className="section-head">Seneste beskeder</h2>
        {recent.length ? (
          <ul className="people">
            {recent.map((n) => (
              <li key={n.id}>
                <span className="grow">{n.subject}</span>
                <span className="muted small">{CHANNEL_LABEL[n.channel as keyof typeof CHANNEL_LABEL]} · {STATUS[n.status] ?? n.status} · {when.format(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="bell">Ingen beskeder endnu.</Empty>
        )}
      </section>
    </Shell>
  );
}
