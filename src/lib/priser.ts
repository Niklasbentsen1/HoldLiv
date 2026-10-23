// Salgssidens priser. HoldLivs egen pris er ikke besluttet: den er ÉN værdi, HOLDLIV_PRICE_TEXT i miljøet (fx "249 kr./md."),
// og indtil den er sat viser siderne "Pris kommer snart". Foreningens egne priser (kontingent m.m.) sættes altid af foreningen selv.
export const holdlivPriceText = (): string | null => process.env.HOLDLIV_PRICE_TEXT?.trim() || null;

/** Når konkurrenternes priser sidst blev læst på deres hjemmesider. Vises ved siden af priserne. */
export const COMPETITOR_CHECKED = "22. oktober 2026";

export interface CompetitorPrices {
  name: string;
  source: { label: string; url: string };
  lines: string[];
}

export const COMPETITORS: CompetitorPrices[] = [
  {
    name: "Klubmodul",
    source: { label: "klubmodul.dk/priser", url: "https://klubmodul.dk/priser" },
    lines: [
      "Startpakke: 9.995 kr. (siden oplyser ikke, om det er engangs eller løbende)",
      "Abonnement pr. medlem: ikke oplyst offentligt, beregnes i en prisberegner",
      "Betalingsløsning (Nets Easy): 102 kr./md. plus 0,34 % + 0,50 kr. pr. Visa/Dankort-betaling (MasterCard og Visa Debet: 0,99 % + 0,50 kr.)",
      "Vagtmodul: 149 kr./md. · Kontraktmodul: 49 kr.",
      "Børneattester, digital post og bankforbindelse: tilkøb, pris ikke vist",
    ],
  },
  {
    name: "Holdsport",
    source: { label: "holdsport.dk/da/hvad-koster-det/klubabonnementer", url: "https://www.holdsport.dk/da/hvad-koster-det/klubabonnementer" },
    lines: [
      "Basis: gratis (med reklamer og færre funktioner)",
      "PRO: 1,34 kr. pr. medlem pr. måned, mindst 169 kr./md., ekskl. moms",
      "Gebyr pr. betaling: 3 til 15 kr.",
      "Hjemmeside 249 kr./md. · Widgets 99 kr./md. · Integreret regnskab 100 kr./md.",
    ],
  },
];

export type Mark = "ja" | "delvist" | "nej";
export interface Row {
  area: string;
  klubmodul: Mark;
  holdsport: Mark;
  holdliv: Mark;
  note?: string;
}

/** Sammenligningen er læst ud fra konkurrenternes hjemmesider på COMPETITOR_CHECKED. HoldLiv-kolonnen følger det, der er bygget. */
export const COMPARISON: Row[] = [
  { area: "Kalender med til- og afmelding", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Holdchat", klubmodul: "nej", holdsport: "ja", holdliv: "ja" },
  { area: "Samkørsel og opgaver", klubmodul: "nej", holdsport: "ja", holdliv: "ja", note: "slås til pr. hold" },
  { area: "Holdopstilling og kampreferat", klubmodul: "nej", holdsport: "ja", holdliv: "ja" },
  { area: "Bødekasse og holdkasse", klubmodul: "nej", holdsport: "ja", holdliv: "ja" },
  { area: "Kontingent, rykkere og restanceliste", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Online indmeldelse med godkendelse", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Venteliste og tilmeldingsloft", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Events og camps med betaling", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Billetsalg med QR-scanning", klubmodul: "nej", holdsport: "ja", holdliv: "ja" },
  { area: "Udlæg og kørselsgodtgørelse", klubmodul: "ja", holdsport: "nej", holdliv: "ja" },
  { area: "Hjemmeside", klubmodul: "ja", holdsport: "delvist", holdliv: "ja", note: "Holdsport: 249 kr./md. ekstra" },
  { area: "Booking af baner, haller og udstyr", klubmodul: "ja", holdsport: "ja", holdliv: "ja" },
  { area: "Vagtplan, kontrakter og børneattester", klubmodul: "delvist", holdsport: "nej", holdliv: "ja", note: "Klubmodul: tilkøb" },
  { area: "Infoskærm og medlemskort", klubmodul: "nej", holdsport: "ja", holdliv: "ja" },
  { area: "Gratis dataflytning ved skift", klubmodul: "ja", holdsport: "delvist", holdliv: "ja", note: "Klubmodul: indgår i startpakken · Holdsport: PRO" },
  { area: "AI-medlemsservice", klubmodul: "nej", holdsport: "nej", holdliv: "ja" },
  { area: "Certificeret bogføring med bankforbindelse", klubmodul: "ja", holdsport: "delvist", holdliv: "nej", note: "ikke bygget endnu" },
  { area: "App i App Store og Google Play", klubmodul: "ja", holdsport: "ja", holdliv: "nej", note: "appen er bygget, men ikke udgivet endnu; HoldLiv virker i browseren" },
  { area: "MobilePay-abonnement til kontingent", klubmodul: "nej", holdsport: "ja", holdliv: "nej", note: "HoldLiv: kort via Stripe, ikke MobilePay-abonnement endnu" },
  { area: "CFR-indberetning", klubmodul: "ja", holdsport: "delvist", holdliv: "nej", note: "HoldLiv: medlemstal som regneark, ingen direkte indberetning" },
  { area: "Webshop", klubmodul: "ja", holdsport: "ja", holdliv: "nej", note: "ikke bygget endnu" },
  { area: "Adgangskontrol (låse og lys)", klubmodul: "ja", holdsport: "ja", holdliv: "nej", note: "ikke bygget endnu" },
  { area: "Integration til forbund (DBU, DHF)", klubmodul: "delvist", holdsport: "ja", holdliv: "nej", note: "ikke bygget endnu" },
];
