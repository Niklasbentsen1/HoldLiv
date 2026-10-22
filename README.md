# HoldLiv

Foreningsplatform til holdsport. Dette er fundamentet: profiler, roller og rettigheder, plus til- og frameldinger, så rollerne kan prøves af i praksis.

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

## Kode

- `src/db/schema.ts` – datamodellen.
- `src/auth/permissions.ts` – rettighedsmotoren `can()` / `assertCan()`. Ren logik uden database.
- `src/auth/context.ts` – henter et logins roller fra databasen.
- `src/services/index.ts` – handlinger (opret barn, tilføj spiller, opret træning, meld til/fra osv.). Alle tjekker rettigheder først.
- `src/app/` – en lille demoside med demo-login, profilskift og til-/framelding.
- `tests/` – tests af reglerne og af handlingerne mod Postgres.

## Kom i gang

```bash
npm install
cp .env.example .env          # ret DATABASE_URL hvis nødvendigt
npx drizzle-kit migrate       # opret tabeller
npm run db:seed               # demodata: Niklas, Mette, Jonas, Karen og Emma
npm run dev                   # http://localhost:3000
npm test                      # kræver en tom testdatabase, se TEST_DATABASE_URL i tests/services.test.ts
```

## Ikke med endnu

- Rigtigt login (fx magic link eller MitID). Demo-login'et vælger bare en person.
- Row-level security i Postgres som ekstra sikring af foreningernes data.
- Trænerens overblik over fremmøde, invitationer til forældre, venteliste og modulmotoren pr. hold.
