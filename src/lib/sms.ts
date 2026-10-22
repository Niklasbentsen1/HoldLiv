// SMS bag en udbyder-grænseflade. Der er endnu ingen rigtig udbyder: indtil Niklas har valgt og oprettet en
// (fx GatewayAPI), bruges en mock, der kun skriver i loggen og i en indbakke i hukommelsen under udvikling og demo.
// En rigtig udbyder tilføjes ved at implementere SmsSender og vælge den i getSmsSender() via SMS_PROVIDER.
export type SmsSender = (to: string, text: string) => Promise<void>;

const g = globalThis as unknown as { holdlivSms?: { to: string; text: string }[] };
export const smsInbox = (g.holdlivSms ??= []);

export const mockSms: SmsSender = async (to, text) => {
  smsInbox.push({ to, text });
  console.log(`[sms] til ${to}: ${text}`);
};

/** Dansk mobilnummer til udbyderen: "20 11 22 33" eller "+45 20112233" -> "4520112233". Andet afvises. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[\s().-]/g, "");
  const m = /^(?:\+?45)?(\d{8})$/.exec(digits);
  return m ? `45${m[1]}` : null;
}

/** Null, når der ikke er nogen SMS-udbyder at sende med (så springes SMS over). */
export function getSmsSender(): SmsSender | null {
  const provider = process.env.SMS_PROVIDER;
  if (provider === "mock" || (!provider && process.env.NODE_ENV !== "production")) return mockSms;
  return null;
}
