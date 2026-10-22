// Sessionens token gemmes sikkert på telefonen (Keychain/Keystore). På web (kun til udvikling) bruges localStorage.
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const KEY = "holdliv_token";

export async function loadToken(): Promise<string | null> {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(KEY) ?? null;
  return SecureStore.getItemAsync(KEY);
}

export async function saveToken(token: string): Promise<void> {
  if (Platform.OS === "web") globalThis.localStorage?.setItem(KEY, token);
  else await SecureStore.setItemAsync(KEY, token);
}

export async function clearToken(): Promise<void> {
  if (Platform.OS === "web") globalThis.localStorage?.removeItem(KEY);
  else await SecureStore.deleteItemAsync(KEY);
}
