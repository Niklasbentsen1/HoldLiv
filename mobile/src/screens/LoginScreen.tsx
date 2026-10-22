import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { api, ApiError } from "../api";
import { colors } from "../theme";
import { Button, Card, ErrorText } from "../ui";

type Step = "email" | "code" | "mfa";

/** Login uden kodeord: e-mail → kode fra mailen → (evt.) to-faktor. onDone får tokenet, når login er fuldført. */
export function LoginScreen({ onDone }: { onDone: (token: string) => void }) {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Noget gik galt.");
    } finally {
      setBusy(false);
    }
  }

  const sendCode = () =>
    run(async () => {
      await api.requestCode(email.trim());
      setStep("code");
    });

  const submitCode = () =>
    run(async () => {
      const r = await api.verifyCode(email.trim(), code.trim());
      if (r.mfaRequired) {
        setPending(r.token);
        setCode("");
        setStep("mfa");
      } else onDone(r.token);
    });

  const submitMfa = () =>
    run(async () => {
      if (!pending) return;
      await api.verifyMfa(pending, code.trim());
      onDone(pending);
    });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.root}>
      <Text style={s.logo}>HoldLiv</Text>
      <Card>
        {step === "email" && (
          <>
            <Text style={s.title}>Log ind</Text>
            <Text style={s.muted}>Skriv din e-mail. Vi sender en kode, så du ikke skal huske et kodeord.</Text>
            <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="navn@eksempel.dk" autoCapitalize="none" autoComplete="email" keyboardType="email-address" accessibilityLabel="E-mail" />
            <ErrorText message={error} />
            <Button title="Send kode" onPress={sendCode} busy={busy} disabled={!email.includes("@")} />
          </>
        )}
        {step === "code" && (
          <>
            <Text style={s.title}>Skriv koden</Text>
            <Text style={s.muted}>Vi har sendt en 6-cifret kode til {email}.</Text>
            <TextInput style={s.input} value={code} onChangeText={setCode} placeholder="123456" keyboardType="number-pad" autoComplete="one-time-code" accessibilityLabel="Kode" />
            <ErrorText message={error} />
            <Button title="Log ind" onPress={submitCode} busy={busy} disabled={code.trim().length < 6} />
            <Button title="Prøv en anden e-mail" kind="plain" onPress={() => { setStep("email"); setError(null); }} />
          </>
        )}
        {step === "mfa" && (
          <>
            <Text style={s.title}>To-faktor</Text>
            <Text style={s.muted}>Skriv koden fra din autentificeringsapp, eller en nødkode.</Text>
            <TextInput style={s.input} value={code} onChangeText={setCode} placeholder="123456" autoCapitalize="none" accessibilityLabel="To-faktorkode" />
            <ErrorText message={error} />
            <Button title="Fortsæt" onPress={submitMfa} busy={busy} disabled={code.trim().length < 6} />
          </>
        )}
      </Card>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: 16, justifyContent: "center", gap: 16 },
  logo: { fontSize: 32, fontWeight: "800", color: colors.primary, textAlign: "center" },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, fontSize: 18, backgroundColor: colors.bg },
});
