"use client";
import { useEffect, useState } from "react";
import { subscribePush, unsubscribePush } from "../actions";

const b64ToBytes = (b64: string) => {
  const raw = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const bytesToB64 = (buf: ArrayBuffer | null) => (buf ? btoa(String.fromCharCode(...new Uint8Array(buf))) : "");

/** Slår push til eller fra i denne browser. Kræver tilladelse fra brugeren og en VAPID-nøgle fra serveren. */
export function PushToggle({ publicKey }: { publicKey: string | null }) {
  const [state, setState] = useState<"checking" | "unsupported" | "off" | "on" | "blocked">("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !publicKey) return setState("unsupported");
    if (Notification.permission === "denied") return setState("blocked");
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("unsupported"));
  }, [publicKey]);

  async function turnOn() {
    setBusy(true);
    setError(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey!) });
      await subscribePush({ endpoint: sub.endpoint, p256dh: bytesToB64(sub.getKey("p256dh")), auth: bytesToB64(sub.getKey("auth")) });
      setState("on");
    } catch {
      setError("Det lykkedes ikke at slå push til. Prøv igen om lidt.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("off");
    } catch {
      setError("Det lykkedes ikke at slå push fra. Prøv igen om lidt.");
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") return null;
  if (state === "unsupported") return <p className="muted small">Push virker ikke i denne browser, eller er ikke sat op på serveren.</p>;
  if (state === "blocked") return <p className="muted small">Push er blokeret i browseren. Tillad notifikationer for HoldLiv i browserens indstillinger.</p>;
  return (
    <div className="row" style={{ gap: 12 }}>
      <span className="muted small">{state === "on" ? "Push er slået til i denne browser." : "Push er ikke slået til i denne browser."}</span>
      <button type="button" className="btn" disabled={busy} onClick={state === "on" ? turnOff : turnOn}>
        {state === "on" ? "Slå fra her" : "Slå til her"}
      </button>
      {error && <span className="small" role="alert">{error}</span>}
    </div>
  );
}
