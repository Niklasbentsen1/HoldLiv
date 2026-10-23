import { MAX_SITE_CONTACT, MAX_SITE_INTRO } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { origin } from "../../../lib/origin";
import { ErrorBox, Shell } from "../../../components/Shell";
import { PageHead } from "../../../components/ui";
import { clubs } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { saveSiteSettingsAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function SiteSettings({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/hjemmeside?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const [[club], base] = await Promise.all([db.select().from(clubs).where(eq(clubs.id, klub)), origin()]);
  const url = `${base}/klub/${club.slug}`;

  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead
        back={{ href: "/forening", label: "Forening" }}
        title="Hjemmeside"
        sub="Foreningens egen side, som alle kan se uden login. Den viser aldrig medlemmer, trænere, børn, svar, beskeder eller betalinger. Aktiviteternes titler og steder og de nyheder, du selv vælger, vises som de er skrevet, så skriv ikke personnavne i dem."
      />
      <ErrorBox message={fejl} />
      <form action={saveSiteSettingsAction} className="card stack">
        <input type="hidden" name="clubId" value={klub} />
        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={club.siteEnabled} /> Tænd hjemmesiden
        </label>
        {club.siteEnabled && (
          <label>
            Adresse
            <input readOnly value={url} className="mono" />
          </label>
        )}
        <label>
          Velkomsttekst
          <textarea name="intro" rows={5} maxLength={MAX_SITE_INTRO} defaultValue={club.siteIntro ?? ""} placeholder="Fortæl kort, hvem I er, og hvad I tilbyder" />
        </label>
        <label>
          Kontakt
          <textarea name="contact" rows={3} maxLength={MAX_SITE_CONTACT} defaultValue={club.siteContact ?? ""} placeholder="Fx formandens e-mail og klubbens adresse" />
        </label>
        <label className="check">
          <input type="checkbox" name="showTeams" defaultChecked={club.siteShowTeams} /> Vis holdene (kun navn og sæson)
        </label>
        <label className="check">
          <input type="checkbox" name="showCalendar" defaultChecked={club.siteShowCalendar} /> Vis kommende aktiviteter de næste 30 dage
        </label>
        <p className="muted small">
          Slået fra som standard. Slår du det til, bliver alle holds træningstider, kampe og steder, også børneholdenes, offentlige og kan findes via søgemaskiner.
        </p>
        <p className="muted small">
          Nyheder vises kun, hvis du under Nyheder trykker "Vis på hjemmesiden" på en nyhed for hele foreningen. Indmeldelseslinket vises, når online indmeldelse er åben.
        </p>
        <button className="primary">Gem</button>
      </form>
    </Shell>
  );
}
