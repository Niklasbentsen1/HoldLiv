// Hvilke slags beskeder og kanaler HoldLiv kender, og hvad der gælder, før et login selv har valgt.
export const CHANNELS = ["mail", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = { mail: "Mail", sms: "SMS" };

export const KINDS = {
  event_change: {
    label: "Ændringer og aflysninger",
    description: "Når en træning eller kamp bliver aflyst, flyttet eller får nyt sted.",
  },
} as const;
export type Kind = keyof typeof KINDS;

/** Mail er slået til som standard. SMS er opt-in, fordi det koster penge og kræver et telefonnummer. */
export const DEFAULT_ENABLED: Record<Channel, boolean> = { mail: true, sms: false };
