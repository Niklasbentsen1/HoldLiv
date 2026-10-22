import Link from "next/link";
import { PRIVACY_VERSION } from "../../services";

export const metadata = { title: "Privatlivspolitik · HoldLiv" };

// UDKAST. Skal gennemgås af en jurist, før HoldLiv bruges af en rigtig forening. Se docs/udkast/.
export default function Privacy() {
  return (
    <main className="stack" style={{ maxWidth: 720, margin: "48px auto", padding: "0 16px" }}>
      <p className="pill">Udkast, version {PRIVACY_VERSION}. Ikke juridisk gennemgået endnu.</p>
      <h1>Privatlivspolitik</h1>
      <p className="muted">Sådan behandler HoldLiv og din forening oplysninger om dig og dine børn.</p>

      <h2>Hvem er ansvarlig?</h2>
      <p>
        Din forening er <strong>dataansvarlig</strong> for oplysningerne om medlemmerne. HoldLiv er <strong>databehandler</strong>: vi opbevarer og
        behandler oplysningerne på foreningens vegne og efter foreningens instruks, aftalt i en databehandleraftale. Kontakt: [KONTAKT-E-MAIL].
      </p>

      <h2>Hvilke oplysninger?</h2>
      <ul>
        <li>Navn, e-mail, telefon og fødselsdato, og for børn hvem der er forældre eller værger.</li>
        <li>Medlemskab, hold, tilmeldinger til aktiviteter, kørselsaftaler, opgaver og bøder.</li>
        <li>Opkrævninger og betalinger. Kortoplysninger ser vi aldrig; de håndteres af betalingsudbyderen.</li>
        <li>Beskeder i holdchatten, nyheder og opslag, som du selv skriver.</li>
        <li>Tekniske oplysninger: login-tidspunkter og en aktivitetslog over foreningens administrative handlinger.</li>
      </ul>

      <h2>Hvorfor, og på hvilket grundlag?</h2>
      <ul>
        <li>For at drive medlemskabet: planlægning, besked ved ændringer, opkrævning af kontingent (kontrakt og foreningens legitime interesse).</li>
        <li>For at opfylde lovkrav, fx bogføring (retlig forpligtelse).</li>
        <li>Billeder og video kun med dit samtykke, som du kan trække tilbage når som helst. For børn giver og trækker værgen samtykket.</li>
      </ul>

      <h2>Hvor længe gemmer vi det?</h2>
      <p>
        Så længe du er medlem. Når du sletter din konto, fjernes alt, der identificerer dig. Opkrævninger og betalinger gemmes uden navn i
        op til fem år efter regnskabsårets udgang, fordi bogføringsloven kræver det.
      </p>

      <h2>Hvem får oplysningerne?</h2>
      <p>
        Foreningens administratorer, kasserer og dine trænere ser det, de skal bruge. Vi bruger underdatabehandlere til hosting, e-mail, SMS og
        betaling. De er opført i databehandleraftalen: [LISTE VED DRIFTSSTART]. Oplysningerne opbevares i EU.
      </p>

      <h2>Dine rettigheder</h2>
      <p>
        Du kan se, hente, rette og slette dine oplysninger, trække samtykker tilbage og klage til Datatilsynet. Under{" "}
        <Link href="/indstillinger/privatliv">Privatliv</Link> i HoldLiv kan du hente alt, hvad vi har om dig og dine børn, som en fil, og slette din
        konto.
      </p>
    </main>
  );
}
