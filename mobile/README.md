# HoldLiv-appen (iOS og Android)

Expo/React Native. Appen taler med HoldLiv via mobil-API'et (`/api/mobil`, se `src/app/api/mobil` i hovedprojektet) og bruger det samme login som nettet: e-mail, kode og evt. to-faktor. Sessionens token ligger i telefonens sikre lager.

## Kør lokalt

```bash
# 1. Start HoldLiv (fra projektets rod): npm run dev   (http://localhost:3000)
# 2. Start appen
cd mobile
npm install
EXPO_PUBLIC_API_URL=http://<din-computers-ip>:3000 EXPO_PUBLIC_MOCK_PUSH=1 npx expo start
```

Scan QR-koden med Expo Go (iOS/Android), eller tryk `i` / `a` for simulator. På en rigtig telefon skal API-adressen være computerens adresse på netværket, ikke `localhost`. Under udvikling står koden til login på skærmen i HoldLiv-serverens log (mailen er en mock).

Skærme: login, aktiviteter (for en selv og børn, med svar ja/måske/nej), indstillinger (push, log ud).

## Push

`src/push.ts` har grænsefladen `PushRegistrar`. Med `EXPO_PUBLIC_MOCK_PUSH=1` bruges en mock-adresse, så flowet kan prøves uden konti. Rigtig push kræver:

1. En Expo-konto og et EAS-projekt: sæt `expo.extra.eas.projectId` i `app.json`.
2. Apple Developer-konto (APNs-nøgle) og Firebase (FCM) tilføjet i EAS.
3. En udviklingsbygning (`eas build --profile development`); Expo Go understøtter ikke fjernpush på Android.
4. På serveren: `EXPO_PUSH=1` (og evt. `EXPO_ACCESS_TOKEN`), så HoldLiv sender via Expo's push-tjeneste.

## Udgivelse

App Store og Google Play kræver udviklerkonti (Apple Developer Program, Google Play Console) og et EAS-projekt; bundle-id/pakkenavn er `dk.holdliv.app` (ret det, hvis kontoen kræver et andet). Ikoner i `assets/` er Expos skabeloner og skal erstattes.

## Tjek

```bash
npx tsc --noEmit
npx expo export --platform android   # bundler JS'en
```
