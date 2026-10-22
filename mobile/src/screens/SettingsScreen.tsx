import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api, ApiError } from "../api";
import { pushRegistrar } from "../push";
import { colors } from "../theme";
import { Button, Card, ErrorText } from "../ui";

export function SettingsScreen({ onLogout }: { onLogout: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function enablePush() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const reg = await pushRegistrar.register();
      if (!reg) {
        setError("Push kunne ikke slås til. Tjek tilladelser i telefonens indstillinger.");
        return;
      }
      await api.registerDevice(reg.token, reg.platform);
      setMessage("Du får nu besked om ændringer og aflysninger.");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Noget gik galt.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={s.root}>
      <Card>
        <Text style={s.title}>Beskeder</Text>
        <Text style={s.muted}>Få besked på telefonen, når en aktivitet ændres eller aflyses. Du vælger selv, hvilke beskeder du vil have, på nettet under Beskeder.</Text>
        <ErrorText message={error} />
        {message && <Text style={{ color: colors.yes }}>{message}</Text>}
        <Button title="Slå push til" onPress={enablePush} busy={busy} />
      </Card>
      <Button title="Log ud" kind="plain" onPress={onLogout} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 16 },
  title: { fontSize: 18, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted },
});
