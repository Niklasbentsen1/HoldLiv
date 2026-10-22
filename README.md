# HoldLiv

Foreningsplatform til holdsport. Indtil videre: profiler, roller og rettigheder, login uden kodeord, hold, kalender med faste træninger og kampe, til- og framelding (også for forældre på barnets vegne) og trænerens fremmødeoverblik.

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
| Foreningsadmin | `club_roles` (`admin`) | Fuld adgang i foreningen. `title` er fri tekst: "Formand", "Kasserer", "Bestyrelsesmedlem". |
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

## Kode

- `src/db/schema.ts` – datamodellen. Migrationer i `drizzle/`.
- `src/auth/permissions.ts` – rettighedsmotoren `can()` / `assertCan()`. Ren logik uden database.
- `src/auth/context.ts` – henter et logins roller fra databasen.
- `src/auth/login.ts` – koder, links og sessioner.
- `src/services/` – handlinger. `index.ts` (profiler, roller, svar), `teams.ts` (hold, familie, invitationer), `calendar.ts` (serier, aflysning, aktivitetens side, fremmøde). Alle tjekker rettigheder først.
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
| Sofie Bak | Mor til Ida (U9) og Lukas (U11) |
| Anne og Lars Møller | Begge forældre til Freja (U9) og Kasper (U11). Lars spiller på senior |
| Ali Hassan, Henrik Juul | Forældre og seniorspillere |

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

Miljøvariabler: `DATABASE_URL`, `RESEND_API_KEY` og `MAIL_FROM` (rigtige mails), `APP_URL` (adressen i login-links), `DEMO_LOGIN=1` (demo-login og kode på skærmen i produktion).

## Ikke med endnu

- Push-beskeder og påmindelser til dem der ikke har svaret.
- Kalenderabonnement (iCal) til telefonens kalender.
- Row-level security i Postgres som ekstra sikring af foreningernes data.
- Medlemskab og kontingent, modulmotoren pr. hold og AI-medlemsservice.
