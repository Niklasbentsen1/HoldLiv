# HoldLiv

Foreningsplatform til holdsport. Indtil videre: profiler, roller og rettigheder, login uden kodeord, hold, kalender med faste træninger og kampe, til- og framelding (også for forældre på barnets vegne), trænerens fremmødeoverblik, og medlemmer og kontingent med betaling til kassereren.

## Stack

- **Next.js 16 + React 19 + TypeScript** til web. Samme TypeScript-kode kan senere bruges fra en React Native-app.
- **PostgreSQL 16** som database, via **Drizzle ORM** (typesikre forespørgsler og SQL-migrationer i `drizzle/`).
- **Vitest** til tests. Rettighedsreglerne testes rent, og handlingerne testes mod en rigtig Postgres.

## Sådan er profiler og roller bygget

| Begreb | Tabel | Forklaring |
|---|---|---|
| Login | `users` | En person der kan logge ind. |
| Profil | `profiles` | En person i HoldLiv. Har den et login, er `user_id` sat. Børn har ingen login. |
| Forælder/værge | `guardianships` | Kobler en voksenprofil til en børneprofil. Et barn kan have flere værger. |
| Medlem | `club_memberships` | Profilen er medlem af foreningen. |
| Foreningsadmin | `club_roles` (`admin`) | Fuld adgang i foreningen. `title` er fri tekst: "Formand", "Bestyrelsesmedlem". |
| Kasserer | `club_roles` (`treasurer`) | Medlemmer, kontingent og betalinger. Ingen adgang til hold og trænere. |
| Træner / spiller | `team_members` (`coach` / `player`) | Pr. hold. Samme profil kan være træner på ét hold og spiller på et andet. |

Roller er rækker, ikke et felt på profilen. Derfor kan én profil bære alle rollerne på én gang, som i eksemplet med Niklas: bestyrelsesmedlem, spiller på senior og far til Emma på U9.

### Hvem må hvad

| Handling | Admin | Træner (eget hold) | Spiller (sig selv) | Forælder (for barnet) |
|---|---|---|---|---|
| Foreningens indstillinger, oprette hold | ✓ | | | |
| Udpege trænere | ✓ | | | |
| Tilføje/fjerne spillere på holdet | ✓ | ✓ | | |
| Oprette og rette træninger/kampe | ✓ | ✓ | | |
| Melde til/fra | ✓ (alle i foreningen) | ✓ (holdets spillere) | ✓ | ✓ |
| Se profil | ✓ | ✓ (holdets spillere) | ✓ | ✓ |
| Rette personoplysninger | ✓ | | ✓ | ✓ |
| Tilføje en ekstra værge | ✓ | | | ✓ |

Kassereren (`finance.manage`) og admin ser medlemslisten, styrer kontingenter og opkrævninger, registrerer og refunderer betalinger og sender rykkere. Kun admin udpeger kassereren. Man betaler selv for sig selv og sine børn (`charge.pay`); kassereren betaler ikke på andres vegne.

Rollerne lægges sammen. Har man flere roller, får man summen af dem, og intet andet.

### At agere som sit barn

Forælderen skifter i appen mellem "Niklas (mig)" og "Emma". Skiftet er kun et visningsvalg; rettighedstjekket spørger altid "må dette login gøre X ved denne profil?". Forælderen må melde Emma fra, fordi forælderen er Emmas værge, og får ingen af Emmas eller trænerens rettigheder ved at skifte.

Hvert svar gemmer, hvilket login der trykkede (`responded_by_user_id`), så træneren kan se "meldt fra af Niklas".

### Regler vi har valgt

- **18 år:** Værgens adgang ophører automatisk på barnets 18-års-dag. Relationen bliver i databasen som historik.
- **Barn med eget login:** Et barn kan senere få eget login på den samme profil. Forælderen bevarer adgangen indtil 18 år.
- **Trænere og personoplysninger:** Trænere styrer holdet og spillerne på det, men retter ikke adresse, telefon og lignende. Det gør personen selv, forælderen eller en admin.
- **Mindst én admin:** En forening kan ikke miste sin sidste admin.
- **Opretteren af en forening** bliver automatisk dens første admin.
- **Profiler er på tværs af foreninger.** Én person med ét login kan være i flere foreninger.

## Login

- Man skriver sin e-mail og får en **6-cifret kode og et link** på mail. Begge virker én gang i 15 minutter. Ingen kodeord.
- Første gang en e-mail bekræftes, oprettes login'et, og personen udfylder navn under `/velkommen`. Børn tilføjes under `/familie`.
- Højst 5 koder pr. e-mail i timen og 5 forsøg pr. kode. Kun hashes af koder, links og sessioner gemmes.
- Sessionen er en tilfældig nøgle i en httpOnly-cookie, gyldig i 30 dage. Log ud sletter den i databasen.
- Mails sendes via [Resend](https://resend.com), når `RESEND_API_KEY` er sat. Uden nøgle viser login-siden koden direkte (kun under udvikling eller med `DEMO_LOGIN=1`).

## Hold og kalender

- **Invitationslink pr. hold** (`/join/<kode>`): træneren deler linket, forælderen logger ind, vælger sit barn og er på holdet. Træneren kan lave et nyt link, så det gamle holder op med at virke.
- **Aktiviteter:** træning, kamp eller anden aktivitet, med sted, beskrivelse og valgfri svarfrist.
- **Faste træninger:** "gentag hver uge til og med" opretter en serie (højst 52). Klokkeslættet holdes i dansk tid, også hen over skift til vintertid.
- **Aflysning:** én aktivitet eller resten af serien. Aflyste aktiviteter bliver stående som aflyst.
- **Svar:** Kommer / Måske / Kommer ikke med valgfri besked. Svar lukker ved svarfristen, eller når aktiviteten starter. Træneren kan altid registrere fremmøde.
- **Hvem ser hvad:** alle på holdet ser hvem der kommer. Beskeder ("syg") og "svaret af Niklas" ser kun trænere/admins og spilleren selv eller forældrene. Forældrenes navne og telefon ser kun trænere/admins.
- **Fremmøde** (`/hold/<id>/fremmoede`): spillere × aktiviteter for de seneste 4, 8 eller 12 uger og de næste 2, med fremmødeprocent og hvem der mangler at svare.

## Medlemmer og kontingent

Kassererens værktøj ligger under **Kasse** (`/kasse`), medlemmernes under **Betaling** (`/betaling`).

- **Kontingentsatser** (`membership_fees`) med beløb og interval: måned, kvartal, halvår eller år. Perioderne følger kalenderen (halvår = jan–jun og jul–dec). Beløb gemmes i øre.
- **Holdets kontingent:** hvert hold kan have et standardkontingent. Nye spillere får det automatisk, når de kommer på holdet, medmindre kassereren allerede har valgt et andet.
- **Medlemslisten** viser hold, forældre, kontingent, gratister og hvem der skylder, med filtre (mangler kontingent, i restance, gratister, udmeldte) og søgning. Kan hentes som CSV til Excel.
- **Gratister** (trænere, frivillige, pause) og **udmeldte** får ingen opkrævninger. Udmeldte bliver stående med historik.
- **Opkrævning:** kassereren sender kontingent for en periode til alle aktive medlemmer på satsen. Det kan gentages uden dobbelte opkrævninger, så nye medlemmer tages med næste gang. Ekstra opkrævninger (stævne, trøje) kan sendes til ét medlem.
- **Betaling:** forælderen eller medlemmet trykker Betal og sendes til Stripe Checkout på foreningens egen Stripe-konto (Connect). Kort, MobilePay og Apple Pay vælges i foreningens Stripe-indstillinger. HoldLiv lægger intet gebyr på.
- **Bekræftelse** kommer fra Stripes webhook (`/api/stripe/webhook`, signaturen tjekkes). Kassereren kan også registrere kontant eller bankoverførsel, annullere og refundere.
- **Rykkere** på mail for forfaldne opkrævninger, til forældrene for børn under 18. Højst én pr. opkrævning om ugen.
- **Testtilstand:** uden `STRIPE_SECRET_KEY` (under udvikling eller med `DEMO_LOGIN=1`) går betalingen til en testside i appen i stedet for Stripe. Der trækkes ingen penge.

Stripe sættes op med `STRIPE_SECRET_KEY` og `STRIPE_WEBHOOK_SECRET`. Webhooken oprettes i Stripe som Connect-webhook med hændelserne `checkout.session.completed` og `checkout.session.async_payment_succeeded`. Kassereren kobler foreningen til Stripe med knappen under Kasse.

## Design

- **Udtryk:** lyse flader med hvide, meget runde kort og én **signaturfarve** (`--brand`). Det vigtigste på hver skærm (fx næste aktivitet) står i et kort med signaturfarven som gradient. Skrift: Bricolage Grotesque (selvhostet via `@fontsource-variable`). Mørk tilstand følger systemet.
- **Signaturfarve:** violet som standard. Skift med `BRAND` i `src/app/layout.tsx` (`"violet"`, `"lagune"` eller `"hindbaer"`). En ny farve kræver kun `--brand` og `--brand-2` i `tokens.css`; toninger udledes automatisk.
- **Tokens** ligger i `src/app/tokens.css`: flader, signalfarve, farver pr. aktivitetstype og svar, radier, skygger. Nye skærme bruger kun disse variabler.
- **Byggeklodser** i `src/components/ui.tsx`: `Icon`, `Avatar`, `AvatarStack`, `Crest` (holdets skjold), `Ring` (procent), `Bars`, `Stat` (talkort), `TypeBadge`, `DateTile`, `PageHead`, `Empty`, `Pitch` (banestreger som baggrund).
- **Klasser** i `src/app/globals.css`: `.card` (evt. `.brand` i signaturfarven eller `.tint` lys toning), `.tiles` (3 talkort), `.dash`/`.team-layout` (indhold + sidekolonne), `.people` (personliste), `.badge`, `.pill`, `.meter`, `.seg`, knapper `.primary`/`.accent`/`.danger`.
- **Menu:** `NAV` i `src/components/Shell.tsx`. Sidebjælke på computer, flydende fanelinje på mobil. Nye områder tilføjes som én linje dér.

## Kode

- `src/db/schema.ts` – datamodellen. Migrationer i `drizzle/`.
- `src/auth/permissions.ts` – rettighedsmotoren `can()` / `assertCan()`. Ren logik uden database.
- `src/auth/context.ts` – henter et logins roller fra databasen.
- `src/auth/login.ts` – koder, links og sessioner.
- `src/services/` – handlinger. `index.ts` (profiler, roller, svar), `teams.ts` (hold, familie, invitationer), `calendar.ts` (serier, aflysning, aktivitetens side, fremmøde), `finance.ts` (medlemmer, kontingent, opkrævninger, betaling, rykkere). Alle tjekker rettigheder først.
- `src/lib/payments.ts` – Stripe Connect og testbetalingen. `src/lib/money.ts` – kroner, øre og perioder.
- `src/lib/time.ts` – dansk tid for formularer og serier.
- `src/app/` – web-appen. Server actions i `actions.ts`.
- `src/db/demo.ts` – demoklubben Skovby IF.
- `tests/` – regler, login, kalender og handlinger mod en rigtig Postgres.

## Demoklubben Skovby IF

Opdigtet forening med tre hold (U9 piger, U11 drenge, Senior herrer), 10 voksne og 9 børn, faste træninger fra tre uger tilbage til seks uger frem, kampe, et forældremøde og svar.

| Person | Roller |
|---|---|
| Karen Lund | Opretter og admin |
| Niklas Bentsen | Bestyrelsesmedlem (admin), spiller på senior, far til Emma (U9) |
| Mette Holm | Træner U9, mor til William (U11) |
| Jonas Krogh | Træner U11, spiller på senior |
| Peter Dam | Træner senior |
| Sofie Bak | Kasserer, mor til Ida (U9) og Lukas (U11) |
| Anne og Lars Møller | Begge forældre til Freja (U9) og Kasper (U11). Lars spiller på senior |
| Ali Hassan, Henrik Juul | Forældre og seniorspillere |

Kontingent: Børn under 13 år (650 kr./halvår), Senior (1.100 kr./halvår) og Passivt medlem (200 kr./år). Trænerne er gratister. Indeværende halvår er opkrævet, og fristen er overskredet: de fleste har betalt, mens Emma, Noor, Oliver og Ali er i restance, så Niklas kan prøve at betale for Emma.

Alle logger ind med `<fornavn>@holdliv.test`.

## Kom i gang

```bash
npm install
cp .env.example .env          # ret DATABASE_URL hvis nødvendigt
npm run db:migrate            # opret tabeller
npm run db:seed               # demoklubben Skovby IF
npm run dev                   # http://localhost:3000
npm test                      # kræver en tom testdatabase, se TEST_DATABASE_URL i tests/db.ts
```

Miljøvariabler: `DATABASE_URL`, `RESEND_API_KEY` og `MAIL_FROM` (rigtige mails), `APP_URL` (adressen i login-links), `DEMO_LOGIN=1` (demo-login, kode på skærmen og testbetaling i produktion), `STRIPE_SECRET_KEY` og `STRIPE_WEBHOOK_SECRET` (rigtige betalinger).

## Ikke med endnu

- Push-beskeder og påmindelser til dem der ikke har svaret.
- Kalenderabonnement (iCal) til telefonens kalender.
- Row-level security i Postgres som ekstra sikring af foreningernes data.
- Automatisk korttræk og MobilePay Subscriptions (kontingentet betales i dag pr. opkrævning).
- Forholdsmæssig pris ved indmeldelse midt i en periode, søskende-/familierabat og indmeldelsesgebyr.
- Spærring af tilmelding ved restance, kvitteringer som PDF og bogføring/eksport til regnskab.
- Modulmotoren pr. hold og AI-medlemsservice.

## Moduler pr. hold

Hvert hold har sine egne moduler (samkørsel, frugt og opgaver, bødekasse). Beskrivelsen ligger i `src/modules/registry.ts`, tilstanden i `team_modules`, og motoren i `src/services/modules.ts`.

- **Foreningens admin** slår moduler til og fra pr. hold (eller for flere hold ad gangen) under Forening. **Trænere** stiller modulets indstillinger på holdets side under Moduler.
- Et slukket modul er helt lukket: modulets funktioner kalder `requireModule()` først. Indstillinger og data bevares, hvis modulet slås fra og til igen.
- Moduler har `available: false`, indtil de er bygget. Så kan de ses, men ikke slås til.
- HoldLiv fastsætter aldrig beløb. Satser i et modul sættes af foreningens egen admin eller træner.
- Et nyt modul: tilføj en række i registret, egne tabeller og en side under `/hold/[id]/<path>`, og kald `requireModule()` i modulets services.

### Modul: samkørsel

Pr. aktivitet kan voksne tilbyde pladser (mødested, afgang, besked), forældre sætter deres barn på en bil eller melder "mangler en lift", og føreren og trænere kan sætte spillere på; føreren kan kun tage spillere med, der har bedt om en lift, og flytter aldrig et barn fra en anden bil. Pladser tælles med lås på bilen, så ingen overbookes. Førerens nummer vises for passagererne, deres forældre og trænere; forældrenes numre vises for føreren og trænere. Kode: `src/services/carpool.ts`, side: `/hold/[id]/samkorsel`.

### Modul: frugt og opgaver

Frugtliste til kampe og træninger og opgaver som kridtning og oprydning. En opgave hører til en familie (en spiller og dennes værger; søskende på samme hold er én familie). Træneren laver frugtlister og opgaver og kan fordele dem retfærdigt: hver opgave går til den familie, der har haft færrest af samme slags (ved lighed den der længst har været uden), og familier der har meldt fra til aktiviteten springes over (`src/modules/fairness.ts`). Familier kan selv tage ledige opgaver, give dem fra sig og sætte dem som udført. Alle på holdet kan se, hvem der har haft hvad. Kode: `src/services/tasks.ts`, side: `/hold/[id]/opgaver`.
