// Push-adressen til denne telefon. Grænsefladen PushRegistrar gør det muligt at skifte udbyder og at bruge en mock i test.
// Rigtig push kræver en udviklingsbygning med APNs/FCM-nøgler i EAS (Expo Go understøtter ikke fjernpush på Android).
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

export interface PushRegistration {
  token: string;
  platform: "ios" | "android";
}
export interface PushRegistrar {
  /** Beder om tilladelse og henter telefonens push-adresse. null, hvis det ikke kan lade sig gøre. */
  register(): Promise<PushRegistration | null>;
}

/** Til udvikling uden udviklerkonti: en fast adresse, så flowet kan prøves uden en rigtig enhed. */
export const mockRegistrar: PushRegistrar = {
  async register() {
    return { token: "ExponentPushToken[mock-dev-device]", platform: Platform.OS === "ios" ? "ios" : "android" };
  },
};

export const expoRegistrar: PushRegistrar = {
  async register() {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
    if (Platform.OS === "android") {
      // Android 13+ spørger først om tilladelse, når der findes en kanal.
      await Notifications.setNotificationChannelAsync("default", { name: "HoldLiv", importance: Notifications.AndroidImportance.DEFAULT });
    }
    const { granted } = await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } });
    if (!granted) return null;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return null; // sættes, når EAS-projektet er oprettet
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: data, platform: Platform.OS };
  },
};

export const pushRegistrar: PushRegistrar = process.env.EXPO_PUBLIC_MOCK_PUSH === "1" ? mockRegistrar : expoRegistrar;

export function setupNotificationHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}
