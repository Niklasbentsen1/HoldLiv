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

Stripe sættes op med `STRIPE_SECRET_KEY` og `STRIPE_WEBHOOK_SECRET`. Webhooken oprettes i Stripe som Connect-webhook med hændelserne `checkout.session.completed`, `checkout.session.async_payment_succeeded` og `payment_intent.succeeded` (den sidste afgør automatiske kortbetalinger, hvor svaret udeblev). Automatisk betaling med gemt kort trækkes af `/api/cron/betalinger` (kald den fx hvert kvarter med `Authorization: Bearer $CRON_SECRET`); foreningen slår det til under Kasse, Kontingenter. Kassereren kobler foreningen til Stripe med knappen under Kasse.

Udlæg og kørsel: medlemmer sender dem på `/udlaeg` (udlæg kræver foto eller PDF af kvitteringen, op til 6 MB); admin og kasserer godkender, betaler og sætter kilometersatsen under Kasse, Udlæg. Satsen og beløbene bestemmer foreningen selv. Bilagene ligger i databasen og kan kun hentes af ejeren og foreningens admin/kasserer.

Medlemstal: Kasse, Medlemstal viser aktive medlemmer pr. aldersgruppe og spillere pr. hold på en valgt dato, som regneark, til kommunens tilskud og forbund. HoldLiv indberetter ikke selv og gemmer ingen CPR-numre eller adresser.

Camps: admin/kasserer opretter dem under Kasse, Camps (pris, pladser, søskenderabat og frist bestemmer foreningen selv). Medlemmer og forældre tilmelder på `/camps`; fuldt hold giver venteliste, og hver bekræftet plads får en opkrævning under Betaling.

Booking af baner, haller og udstyr: admin/kasserer opretter ressourcer under Kasse, Booking (type, antal enheder, leje pr. time og om medlemmers bookinger skal godkendes; lejen bestemmer foreningen selv, 0 = gratis). Medlemmer og forældre (for børn) booker på `/booking` og ser, hvem der har booket de næste 14 dage (kun fornavn eller holdnavn). Dobbeltbooking afvises, og udstyr kan bookes, til alle enheder er brugt (ressourcen låses under booking, så to samtidige kan ikke tage den sidste). Koster det noget, får medlemmet en opkrævning (type `booking`) under Betaling, når bookingen er bekræftet. Trænere og admin booker for et hold uden leje. Afbooking af en betalt booking kræver, at kassereren har refunderet først. Kode: `src/services/booking.ts`. `npm run db:seed` giver Skovby IF en bane, en hal med godkendelse og bolde.

Vagtplan, kontrakter og børneattester: admin (eller et holds træner for sit hold) opretter vagter på `/vagtplan` med antal pladser, sted og om vagten kræver børneattest. Medlemmer (fra 15 år) og forældre (for børn) tager vagter først til mølle; to vagter på samme tid afvises, og de tilmeldte får besked ved aflysning og en påmindelse dagen før. Kontrakter (trænerkontrakt, spillerkontrakt, frivilligaftale) oprettes af admin under Forening, Kontrakter: tekst, perioden og et eventuelt månedligt beløb bestemmer foreningen selv, skabelonerne har ingen beløb. Teksten låses med et hash ved afsendelse, og modtageren (for en under 18 år en værge) skriver under med sit fulde navn på `/kontrakter`. Det er en enkel accept, ikke MitID. Børneattester sporer kun status: foreningen kræver en attest, personen (eller værgen) giver samtykke i HoldLiv (eller foreningen registrerer et skriftligt), og først derefter markerer admin, at attesten er bestilt hos Politiet via virk.dk med foreningens eget login, og registrerer svaret og hvornår en ny skal hentes. HoldLiv gemmer aldrig attesten eller CPR-nummer. En vagt med børneattest-krav kan kun tages med en gyldig attest på vagtens dag. Kun admin ser attestlisten. Påmindelser (vagter, ikke-underskrevne eller udløbende kontrakter, manglende samtykke og udløbende attester) sendes af `/api/cron/vagter` med `CRON_SECRET`, fx hver time. Kode: `src/services/vagter.ts`, `kontrakter.ts` og `attester.ts`.

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

Miljøvariabler: `DATABASE_URL`, `RESEND_API_KEY` og `MAIL_FROM` (rigtige mails), `APP_URL` (adressen i login-links), `DEMO_LOGIN=1` (demo-login, kode på skærmen og testbetaling i produktion), `STRIPE_SECRET_KEY` og `STRIPE_WEBHOOK_SECRET` (rigtige betalinger), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` og `VAPID_SUBJECT` (push i browseren; lav nøgler med `npx web-push generate-vapid-keys`, uden dem bruges en mock udenfor produktion), `CRON_SECRET` (til påmindelser), `TOTP_ENC_KEY` (64 hex-tegn; krypterer to-faktor-hemmeligheder, kræves i produktion; lav den med `openssl rand -hex 32`), `REQUIRE_2FA=1` (admin og kasserer skal bruge to-faktor), `ANTHROPIC_API_KEY` og `ANTHROPIC_MODEL` (AI-rådgiveren på Holdforslag og medlemsservicen under Hjælp; uden nøgle bruges en mock udenfor produktion, og der sendes kun sammentalte tal, aldrig personer), `SMS_PROVIDER=mock` (SMS skrives i loggen i stedet for at blive sendt; uden udbyder springes SMS over i produktion).

Beskeder: ændringer og aflysninger af aktiviteter sendes som mail (og SMS, hvis man har valgt det) til spilleren selv og til forældre til børn under 18. Hver person vælger kanaler under `/indstillinger`. Holdchat er et modul, foreningen slår til pr. hold. Grupperne (hele holdet, trænere, trænere og forældre) og aktivitetens egen chat regnes automatisk ud fra holdets trænere, spillere og forældre. Børn har intet login og er aldrig med; foreningens admin er ikke med automatisk. Nye beskeder giver push (mail er fra som standard), højst én pr. samtale hvert tiende minut.

Nyheder og opslagstavle (`/nyheder`): ledelsen (foreningens admin, holdets trænere) skriver nyheder til hele foreningen eller ét hold, og medlemmerne får besked. Alle, der hører til (også forældre), kan hænge opslag op på opslagstavlen; de udløber af sig selv (30 dage som standard) og giver ingen besked.

Påmindelser om ubesvarede aktiviteter sendes et døgn før svarfristen (eller før starten) af `GET/POST /api/cron/paaminde` med `Authorization: Bearer $CRON_SECRET`; kald den fx hvert kvarter, hver besked sendes kun én gang. Alle forsøg gemmes i tabellen `notifications`, og en fejl hos udbyderen afviser aldrig selve ændringen.

## Ikke med endnu

- Push-beskeder og påmindelser til dem der ikke har svaret.
- Kalenderabonnement (iCal) til telefonens kalender.
- Row-level security i Postgres som ekstra sikring af foreningernes data.
- Automatisk korttræk og MobilePay Subscriptions (kontingentet betales i dag pr. opkrævning).
- Forholdsmæssig pris ved indmeldelse midt i en periode, søskende-/familierabat og indmeldelsesgebyr.
- Spærring af tilmelding ved restance, kvitteringer som PDF og bogføring/eksport til regnskab.
- Modulmotoren pr. hold og AI-medlemsservice.

## Moduler pr. hold

Hvert hold har sine egne moduler (samkørsel, frugt og opgaver, bødekasse, kampe og opstilling). Beskrivelsen ligger i `src/modules/registry.ts`, tilstanden i `team_modules`, og motoren i `src/services/modules.ts`.

- **Foreningens admin** slår moduler til og fra pr. hold (eller for flere hold ad gangen) under Forening. **Trænere** stiller modulets indstillinger på holdets side under Moduler.
- Et slukket modul er helt lukket: modulets funktioner kalder `requireModule()` først. Indstillinger og data bevares, hvis modulet slås fra og til igen.
- Moduler har `available: false`, indtil de er bygget. Så kan de ses, men ikke slås til.
- HoldLiv fastsætter aldrig beløb. Satser i et modul sættes af foreningens egen admin eller træner.
- Et nyt modul: tilføj en række i registret, egne tabeller og en side under `/hold/[id]/<path>`, og kald `requireModule()` i modulets services.

### Modul: samkørsel

Pr. aktivitet kan voksne tilbyde pladser (mødested, afgang, besked), forældre sætter deres barn på en bil eller melder "mangler en lift", og føreren og trænere kan sætte spillere på; føreren kan kun tage spillere med, der har bedt om en lift, og flytter aldrig et barn fra en anden bil. Pladser tælles med lås på bilen, så ingen overbookes. Førerens nummer vises for passagererne, deres forældre og trænere; forældrenes numre vises for føreren og trænere. Kode: `src/services/carpool.ts`, side: `/hold/[id]/samkorsel`.

### Modul: frugt og opgaver

Frugtliste til kampe og træninger og opgaver som kridtning og oprydning. En opgave hører til en familie (en spiller og dennes værger; søskende på samme hold er én familie). Træneren laver frugtlister og opgaver og kan fordele dem retfærdigt: hver opgave går til den familie, der har haft færrest af samme slags (ved lighed den der længst har været uden), og familier der har meldt fra til aktiviteten springes over (`src/modules/fairness.ts`). Familier kan selv tage ledige opgaver, give dem fra sig og sætte dem som udført. Alle på holdet kan se, hvem der har haft hvad. Kode: `src/services/tasks.ts`, side: `/hold/[id]/opgaver`.

### Modul: bødekasse

Holdets egen bødekasse. Satserne og beløbene bestemmer holdet selv (trænere og admin); HoldLiv har ingen standardsatser. Aldersgrænsen er en indstilling pr. hold (standard 12 år, kan sættes fra 6 til 18) og tjekkes, når bøden gives: spillere under grænsen eller uden kendt fødselsdato kan ikke få bøder. Gamle bøder beholder beskrivelse og beløb, hvis satsen senere ændres. Kun trænere og admin giver bøder, sætter dem som betalt og trækker dem tilbage; betalingen sker uden for HoldLiv (kontant eller MobilePay til holdkassen). Spilleren og forældrene ser egne bøder; resten af holdet ser kun, hvor meget der er i kassen. Kode: `src/services/fines.ts`, side: `/hold/[id]/bodekasse`.

### Modul: kampe og opstilling

Trænerens kampark til aktiviteter af typen kamp: modstander, opstilling (på banen og bænken, position, fri tekst til formation), resultat med spilletid, mål med assist, gule og røde kort, og et kampreferat. Opstilling og referat er kladder, til trænerne udgiver dem; opstillingen sendes da som besked. Alle på holdet ser resultat, mål og udgivet referat; kort ser kun trænerne og spillerens egen familie. Statistikken tæller kun spillede kampe (resultat indtastet): holdets sejre, uafgjorte, nederlag og mål, og pr. spiller kampe, starter, spilletid, mål, assists og kort. Indstillinger pr. hold: antal spillere på banen (3-11, standard 7) og om hele holdet ser en topscorerliste (standard slået fra, så børn ikke rangeres; spillere og forældre ser kun egne tal, trænerne ser alle). Ved sletning af en profil fjernes opstilling og kort, og mål bliver stående som mål uden navn. Kode: `src/services/matches.ts`, sider: `/hold/[id]/kampe` og `/hold/[id]/kampe/[eventId]`. `npm run db:seed` giver U9 en spillet kamp med referat og en kommende med opstilling.

### Sikkerhed

- **To-faktor** (TOTP med nødkoder) kan slås til af alle under Beskeder → To-faktor. Med `REQUIRE_2FA=1` kræves det af foreningens admin og kasserer. Sessionen for en konto med to-faktor giver ingen adgang, før koden er tastet.
- **Aktivitetslog** (`audit_log`): roller, medlemmer, økonomi, eksport og login. Foreningens admin læser den på `/forening/log`. Appen kan kun indsætte og læse, aldrig ændre eller slette.
- **Row-level security** (migration 0015): hver foreningsbunden tabel har en politik, så en forespørgsel kun ser rækker i de foreninger, brugeren (eller brugerens børn) er medlem af. Politikkerne gælder rollen `holdliv_app`. Brug `withUserScope(db, userId, fn)` fra `src/db/scope.ts`; den sætter rollen og `app.user_id` for transaktionen. Ejeren (migrationer, cron, webhooks, login) omgår RLS. Ved hosting (punkt 15) skal appen forbinde som en bruger uden ejerrettigheder, der er medlem af `holdliv_app`, og kalde `withUserScope` for brugerforespørgsler; indtil da er RLS en forberedt ekstra sikring, og rettighedsmotoren (`can`) er stadig den primære. Appens databasebruger skal være medlem af rollen (`GRANT holdliv_app TO <app-bruger>`), ellers kan den ikke skifte rolle. Oprettelse af en forening (`createClub`) kører som systemet, fordi foreningen ikke findes endnu. Personbundne tabeller (users, profiles, sessions, notifikationer) er ikke omfattet.

### GDPR

- **Samtykker** (`consents`): privatlivspolitikken accepteres ved oprettelse; billeder og video er et frivilligt samtykke pr. person, som en værge giver og trækker for børn. Et trukket samtykke bevares med tidspunkt.
- **Dataudtræk**: Indstillinger → Privatliv → Hent som fil giver alt om en selv og børn man er værge for som JSON.
- **Sletning**: Slet min konto anonymiserer personen og sletter login, beskeder, opslag, svar og tilmeldinger. Opkrævninger og betalinger gemmes uden navn (bogføringsloven). Spærres af ubetalte opkrævninger og af at være foreningens eneste admin. Børn med en anden værge bliver, børn hvor man er eneste værge slettes med.
- Udkast til privatlivspolitik (`/privatliv`) og databehandleraftale (`docs/udkast/`) er **udkast til en jurist**, ikke færdige.

## AI-medlemsservice

Under *Hjælp* kan medlemmer stille spørgsmål om egne (og børns) aktiviteter og betalinger. Foreningens admin slår tjenesten til på Forening-siden (fra som standard). Med en rigtig udbyder (`ANTHROPIC_API_KEY`) kræves medlemmets samtykke (Privatliv), personer og hold sendes som "Person 1"/"Hold 1", og navnene sættes ind igen i svaret. Tjenesten kan kun læse, har en grænse på 30 spørgsmål i døgnet, og spørgsmålets tekst gemmes ikke i loggen.

Holdkasse (modul "teamfund"): admin slår modulet til pr. hold. Trænerne (og admin) bogfører indbetalinger og udgifter på `/hold/<id>/holdkasse` med beløb, tekst og dato; hele holdet og forældrene ser saldo og poster, men kun trænerne ser, hvem der har betalt ind. Beløbene bestemmer holdet selv. Poster slettes aldrig, men annulleres; kassen kan ikke gå i minus (en udgift over saldoen afvises, og en indbetaling der allerede er brugt kan ikke annulleres). Holdkassen er adskilt fra bødekassen. Sletter man et medlem, fjernes navnet fra posten, men beløbet bliver stående. Kode: `src/services/holdkasse.ts`.

Afstemninger (modul "polls"): trænere og admin starter en afstemning på `/hold/<id>/afstemninger` med 2 til 10 svarmuligheder, valgfrit sluttidspunkt, om man må vælge flere svar, og om den er anonym. Holdet får besked. Der er én stemme pr. spiller; en forælder stemmer for sit barn, og stemmen kan skiftes eller trækkes tilbage, til afstemningen lukker (ved sluttidspunktet eller når en træner lukker den). Resultatet vises, når man har stemt eller afstemningen er lukket; trænerne ser det altid, og kun de ser navnene, aldrig i en anonym afstemning. Kode: `src/services/afstemninger.ts`.
