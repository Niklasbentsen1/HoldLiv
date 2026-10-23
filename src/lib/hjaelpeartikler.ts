// Hjælpecenterets artikler. Skrevet på dansk til foreningens admin, kasserer, trænere og forældre.
// Tilføj en artikel ved at tilføje et objekt her; søgning og oversigt tager den med automatisk.
export type Audience = "admin" | "kasserer" | "traener" | "foraelder";

export const AUDIENCES: Record<Audience, string> = {
  admin: "Foreningens administrator",
  kasserer: "Kasserer",
  traener: "Træner",
  foraelder: "Forælder og medlem",
};

export interface Article {
  slug: string;
  title: string;
  audiences: Audience[];
  summary: string;
  /** Ekstra søgeord (synonymer), der ikke står i teksten. */
  keywords?: string[];
  /** Hvert afsnit er en linje; linjer, der starter med "- ", vises som punkter. */
  body: string[];
  /** Sti i appen, hvor man gør det. */
  link?: { href: string; label: string };
}

export const ARTICLES: Article[] = [
  {
    slug: "opret-forening",
    title: "Opret jeres forening",
    audiences: ["admin"],
    summary: "Sådan kommer en ny forening i gang på få minutter.",
    keywords: ["ny forening", "start", "kom i gang", "første admin"],
    body: [
      "Log ind med din e-mail og vælg Opret forening. Du bliver foreningens første administrator.",
      "Bagefter viser Kom i gang-guiden, hvad der mangler: hold, medlemmer, medadministrator, indmeldelse, hjemmeside og kontingent.",
      "Foreningen skal altid have mindst én administrator. Tilføj gerne en mere, så foreningen ikke hænger på én person.",
    ],
    link: { href: "/opret-forening", label: "Opret forening" },
  },
  {
    slug: "flyt-medlemmer",
    title: "Flyt medlemmerne fra Klubmodul, Holdsport eller Excel",
    audiences: ["admin"],
    summary: "Gratis import af medlemslisten, hvor du ser resultatet, før noget gemmes.",
    keywords: ["import", "csv", "klubmodul", "holdsport", "excel", "dataflytning", "medlemsliste", "eksport"],
    body: [
      "Eksportér medlemslisten fra jeres nuværende system som CSV eller Excel, og vælg filen under Importér medlemmer.",
      "HoldLiv gætter, hvilke kolonner der er navn, fødselsdato, e-mail, telefon, hold og forælder. Du kan rette koblingen, før noget gemmes.",
      "- Udmeldte medlemmer (efter statuskolonnen) flyttes ikke med.",
      "- Hold, der ikke findes, oprettes. Eksisterende medlemmer overskrives aldrig.",
      "- Højst 5000 medlemmer ad gangen.",
    ],
    link: { href: "/forening", label: "Gå til Forening" },
  },
  {
    slug: "hold-og-invitation",
    title: "Opret hold og inviter trænere og forældre",
    audiences: ["admin", "traener"],
    summary: "Hvert hold har sit eget invitationslink.",
    keywords: ["invitation", "link", "join", "tilmeld hold", "årgang"],
    body: [
      "Opret holdet under Forening. Holdets side viser et invitationslink, som du sender til trænere og forældre.",
      "Forældre vælger, hvilket barn der skal på holdet. Linket kan nulstilles, hvis det er kommet forkerte steder hen.",
    ],
    link: { href: "/forening", label: "Gå til Forening" },
  },
  {
    slug: "aktiviteter-og-svar",
    title: "Opret aktiviteter og få svar fra spillerne",
    audiences: ["traener", "admin"],
    summary: "Træninger, kampe og arrangementer med tilmelding og svarfrist.",
    keywords: ["kalender", "træning", "kamp", "gentag", "aflys", "fremmøde", "svarfrist"],
    body: [
      "Opret en aktivitet på holdets side. Du kan gentage den hver uge og aflyse en enkelt gang eller resten af serien.",
      "Spillere og forældre svarer kommer, kommer ikke eller måske. Træneren kan altid registrere fremmøde.",
    ],
  },
  {
    slug: "kontingent",
    title: "Opret kontingenter og opkræv betaling",
    audiences: ["kasserer", "admin"],
    summary: "Foreningen sætter selv alle priser. HoldLiv fastsætter ingen.",
    keywords: ["pris", "betaling", "opkrævning", "rykker", "stripe", "restance", "faktura"],
    body: [
      "Opret kontingenter under Kasse med jeres egne beløb og intervaller. Giv et hold et standardkontingent, så nye spillere får det automatisk.",
      "Opkrævninger sendes til forældrene, som betaler under Betaling. Forfaldne opkrævninger kan give rykkere.",
      "Pengene går direkte til foreningens egen Stripe-konto.",
    ],
    link: { href: "/kasse", label: "Gå til Kasse" },
  },
  {
    slug: "online-indmeldelse",
    title: "Åbn for online indmeldelse",
    audiences: ["admin"],
    summary: "Nye medlemmer melder sig ind via et link, og du godkender.",
    keywords: ["tilmelding", "nyt medlem", "aldersgrænse", "betingelser"],
    body: [
      "Slå indmeldelse til under Indmeldelse. Du kan sætte aldersgrænser og skrive foreningens egne betingelser.",
      "Hver ansøgning godkendes af en administrator, før personen bliver medlem.",
    ],
    link: { href: "/forening", label: "Gå til Forening" },
  },
  {
    slug: "hjemmeside",
    title: "Foreningens hjemmeside",
    audiences: ["admin"],
    summary: "En offentlig side med hold, aktiviteter og indmeldelse.",
    keywords: ["website", "offentlig", "nyheder", "billetter"],
    body: [
      "Siden er slået fra som standard. Når du tænder den, kan alle se den uden login.",
      "Den viser aldrig medlemmer, trænere, børn, svar, beskeder eller betalinger. Skriv derfor ikke personnavne i titler, steder og nyheder.",
    ],
  },
  {
    slug: "log-ind",
    title: "Sådan logger du ind",
    audiences: ["foraelder", "traener", "kasserer", "admin"],
    summary: "Du bruger en kode på mail i stedet for et kodeord.",
    keywords: ["kode", "adgangskode", "glemt", "mail", "login", "to-faktor"],
    body: [
      "Skriv din e-mail, og vi sender en kode, som virker i 15 minutter. Du kan også bruge linket i mailen.",
      "Kommer mailen ikke, så tjek spam. Du kan bede om en ny kode, men højst nogle gange i timen.",
      "Administratorer og kasserere kan bruge to-faktor under Beskeder og indstillinger.",
    ],
    link: { href: "/login", label: "Log ind" },
  },
  {
    slug: "boern-og-familie",
    title: "Børn, forældre og familie",
    audiences: ["foraelder"],
    summary: "Børn har ikke eget login; du styrer dem som forælder.",
    keywords: ["barn", "børn", "tilføj barn", "værge", "familie"],
    body: [
      "Tilføj dine børn under Familie. Du svarer på aktiviteter og betaler for dem.",
      "Barnet har ikke eget login. Når barnet fylder 18, kan du ikke længere svare eller betale for barnet. Skriv til foreningen, så hjælper de den unge i gang med eget login.",
    ],
    link: { href: "/familie", label: "Gå til Familie" },
  },
  {
    slug: "svar-paa-aktivitet",
    title: "Svar på træning og kampe",
    audiences: ["foraelder"],
    summary: "Meld til eller fra, og se hvem der kommer.",
    keywords: ["tilmeld", "afbud", "melde fra", "kalender", "frist"],
    body: [
      "Åbn aktiviteten og vælg kommer, kommer ikke eller måske. Du kan ændre dit svar, til fristen er gået eller aktiviteten starter.",
      "Efter fristen kan kun træneren registrere dig.",
    ],
    link: { href: "/", label: "Til overblik" },
  },
  {
    slug: "betal-kontingent",
    title: "Betal kontingent og se kvitteringer",
    audiences: ["foraelder"],
    summary: "Alle opkrævninger og betalinger samlet ét sted.",
    keywords: ["betaling", "regning", "kvittering", "forfalden", "kort"],
    body: [
      "Under Betaling ser du ubetalte opkrævninger for dig og dine børn og kan betale med kort.",
      "Har foreningen slået det til, kan du gemme et kort, så forfaldne opkrævninger trækkes automatisk.",
    ],
    link: { href: "/betaling", label: "Gå til Betaling" },
  },
  {
    slug: "privatliv",
    title: "Privatliv, samtykke og sletning",
    audiences: ["foraelder", "admin"],
    summary: "Sådan behandles oplysninger, og hvordan du trækker samtykke tilbage.",
    keywords: ["gdpr", "persondata", "slet", "samtykke", "indsigt"],
    body: [
      "Foreningen er dataansvarlig, HoldLiv er databehandler. Læs privatlivspolitikken for detaljerne.",
      "Du kan se, hvilke samtykker du har givet, og trække dem tilbage under Privatliv.",
    ],
    link: { href: "/indstillinger/privatliv", label: "Dine samtykker under Privatliv" },
  },
];

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Søger i titel, resumé, søgeord og tekst. Æ/ø/å og aa/ae/oe er ligegyldige. Bedste træf først. */
export function searchArticles(query: string, audience?: Audience, articles: Article[] = ARTICLES): Article[] {
  const pool = audience ? articles.filter((a) => a.audiences.includes(audience)) : articles;
  const words = fold(query).split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (words.length === 0) return pool;
  return pool
    .map((a) => {
      const title = fold(a.title);
      const kw = fold((a.keywords ?? []).join(" "));
      const rest = fold(`${a.summary} ${a.body.join(" ")}`);
      let score = 0;
      for (const w of words) {
        const s = (title.includes(w) ? 5 : 0) + (kw.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0);
        if (s === 0) return { a, score: 0 };
        score += s;
      }
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.a);
}

export const findArticle = (slug: string) => ARTICLES.find((a) => a.slug === slug) ?? null;
