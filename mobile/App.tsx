import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { api, ApiError, type Person } from "./src/api";
import { setupNotificationHandler } from "./src/push";
import { clearToken, loadToken, saveToken } from "./src/storage";
import { colors } from "./src/theme";
import { EventsScreen } from "./src/screens/EventsScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";

setupNotificationHandler();

type Tab = "events" | "settings";

export default function App() {
  const [state, setState] = useState<"loading" | "out" | "in">("loading");
  const [people, setPeople] = useState<Person[]>([]);
  const [tab, setTab] = useState<Tab>("events");
  const [error, setError] = useState<string | null>(null);

  const enter = useCallback(async () => {
    try {
      setPeople((await api.me()).people);
      setError(null);
      setState("in");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        await clearToken();
        setState("out");
      } else {
        // 403 (fx to-faktor mangler) og netværksfejl vises, men sletter ikke login'et.
        setError(e instanceof ApiError ? e.message : "Noget gik galt.");
        setState("out");
      }
    }
  }, []);

  useEffect(() => {
    (async () => ((await loadToken()) ? enter() : setState("out")))();
  }, [enter]);

  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    await clearToken();
    setPeople([]);
    setState("out");
  }, []);

  if (state === "loading") {
    return (
      <View style={s.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (state === "out") {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="dark" />
        {error && <Text style={s.banner}>{error}</Text>}
        <LoginScreen onDone={async (token) => { await saveToken(token); await enter(); }} />
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <StatusBar style="dark" />
      <View style={{ flex: 1 }}>{tab === "events" ? <EventsScreen people={people} onUnauthorized={logout} /> : <SettingsScreen onLogout={logout} />}</View>
      <View style={s.tabs}>
        {(["events", "settings"] as Tab[]).map((t) => (
          <Pressable key={t} accessibilityRole="tab" accessibilityState={{ selected: tab === t }} onPress={() => setTab(t)} style={s.tab}>
            <Text style={[s.tabText, tab === t && { color: colors.primary }]}>{t === "events" ? "Aktiviteter" : "Indstillinger"}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  banner: { backgroundColor: colors.card, color: colors.danger, padding: 12, textAlign: "center" },
  tabs: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card },
  tab: { flex: 1, alignItems: "center", paddingVertical: 14 },
  tabText: { fontWeight: "600", color: colors.muted },
});
