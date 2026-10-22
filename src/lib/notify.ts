// Hvilke slags beskeder og kanaler HoldLiv kender, og hvad der gælder, før et login selv har valgt.
export const CHANNELS = ["mail", "push", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = { mail: "Mail", push: "Push i browseren", sms: "SMS" };

export const KINDS = {
  event_change: {
    label: "Ændringer og aflysninger",
    description: "Når en træning eller kamp bliver aflyst, flyttet eller får nyt sted.",
  },
  event_reminder: {
    label: "Påmindelser om at svare",
    description: "Dagen før svarfristen (eller før aktiviteten), hvis du eller dit barn ikke har meldt til eller fra.",
  },
} as const;
export type Kind = keyof typeof KINDS;

/** Mail og push er slået til som standard (push sendes kun til browsere, der har sagt ja). SMS er opt-in, fordi det koster penge og kræver et telefonnummer. */
export const DEFAULT_ENABLED: Record<Channel, boolean> = { mail: true, push: true, sms: false };
