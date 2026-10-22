// Hvilke slags beskeder og kanaler HoldLiv kender, og hvad der gælder, før et login selv har valgt.
export const CHANNELS = ["mail", "push", "sms"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = { mail: "Mail", push: "Push i browseren", sms: "SMS" };

export const KINDS = {
  news: {
    label: "Nyheder fra foreningen og holdet",
    description: "Når foreningen eller et af dine hold skriver en nyhed. Opslagstavlen giver ingen beskeder.",
  },
  chat: {
    label: "Nye beskeder i holdchatten",
    description: "Højst én besked pr. samtale hvert tiende minut, så du ikke bliver overdænget.",
    // Chat er mange små beskeder, så mail er fra som standard.
    defaults: { mail: false },
  },
  event_change: {
    label: "Ændringer og aflysninger",
    description: "Når en træning eller kamp bliver aflyst, flyttet eller får nyt sted.",
  },
  waitlist: {
    label: "Plads på en aktivitet eller et hold",
    description: "Når du eller dit barn rykker op fra en venteliste og får en plads, og for trænere når der bliver en ledig plads.",
  },
  payment: {
    label: "Betaling og automatisk træk",
    description: "Når et gemt kort er trukket, eller en automatisk betaling ikke kunne gennemføres, så du selv kan betale. Mail kan ikke slås fra, fordi der er tale om penge.",
    // Der trækkes penge, så betaleren skal altid kunne se det.
    mandatory: ["mail"],
  },
  event_reminder: {
    label: "Påmindelser om at svare",
    description: "Dagen før svarfristen (eller før aktiviteten), hvis du eller dit barn ikke har meldt til eller fra.",
  },
} as const;
export type Kind = keyof typeof KINDS;

/** Mail og push er slået til som standard (push sendes kun til browsere, der har sagt ja). SMS er opt-in, fordi det koster penge og kræver et telefonnummer. */
export const DEFAULT_ENABLED: Record<Channel, boolean> = { mail: true, push: true, sms: false };

/** Standard for en kanal og slags besked, før man selv har valgt. */
export const isMandatory = (kind: Kind, channel: Channel) => ((KINDS[kind] as { mandatory?: readonly Channel[] }).mandatory ?? []).includes(channel);

export function defaultEnabled(kind: Kind, channel: Channel): boolean {
  const own = (KINDS[kind] as { defaults?: Partial<Record<Channel, boolean>> }).defaults?.[channel];
  return own ?? DEFAULT_ENABLED[channel];
}
