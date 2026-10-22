import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { colors } from "./theme";

export function Button({ title, onPress, kind = "primary", busy, disabled, style }: { title: string; onPress: () => void; kind?: "primary" | "plain"; busy?: boolean; disabled?: boolean; style?: ViewStyle }) {
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={[s.button, primary ? s.primary : s.plain, (disabled || busy) && { opacity: 0.6 }, style]}
    >
      {busy ? <ActivityIndicator color={primary ? colors.primaryText : colors.primary} /> : <Text style={[s.buttonText, { color: primary ? colors.primaryText : colors.text }]}>{title}</Text>}
    </Pressable>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={s.card}>{children}</View>;
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{message}</Text> : null;
}

const s = StyleSheet.create({
  button: { minHeight: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  primary: { backgroundColor: colors.primary },
  plain: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  buttonText: { fontSize: 16, fontWeight: "600" },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 16, gap: 8 },
});
