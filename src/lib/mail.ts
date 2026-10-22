// Afsendelse af login-mails. Med RESEND_API_KEY sendes rigtige mails via Resend.
// Uden nøgle (under udvikling, eller i en demo med DEMO_LOGIN=1) lægges mailen i en indbakke
// i hukommelsen, som login-siden viser.
const g = globalThis as unknown as { holdlivOutbox?: Map<string, { code: string; link: string }> };
const outbox = (g.holdlivOutbox ??= new Map());

export const devOutboxEnabled = () =>
  !process.env.RESEND_API_KEY && (process.env.NODE_ENV !== "production" || process.env.DEMO_LOGIN === "1");

export async function sendLoginMail(email: string, code: string, link: string) {
  const text = `Din kode til HoldLiv er ${code}\n\nDu kan også logge ind med dette link:\n${link}\n\nKoden og linket virker i 15 minutter. Har du ikke bedt om det, kan du se bort fra mailen.`;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (!devOutboxEnabled()) throw new Error("RESEND_API_KEY mangler, så der kan ikke sendes login-mails");
    outbox.set(email, { code, link });
    console.log(`[mail] til ${email}: kode ${code}, link ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM ?? "HoldLiv <login@holdliv.dk>",
      to: email,
      subject: `${code} er din kode til HoldLiv`,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Mailen kunne ikke sendes (${res.status})`);
}

export function readDevOutbox(email: string) {
  return devOutboxEnabled() ? (outbox.get(email) ?? null) : null;
}
