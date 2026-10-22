// Modulerne HoldLiv kan slå til pr. hold. Ren beskrivelse uden database, så web, app og
// AI-medlemsservice kan bruge den samme liste.
//
// Et modul har en nøgle (gemmes i databasen), et navn og en side under holdet. Det kan have
// indstillinger, som foreningen selv vælger. HoldLiv fastsætter aldrig beløb: satser og
// priser i et modul sættes af foreningens egen admin eller træner.

export type ModuleKey = "carpool" | "tasks" | "fines";

export type ConfigField =
  | { key: string; label: string; type: "int"; min: number; max: number; default: number; hint?: string }
  | { key: string; label: string; type: "bool"; default: boolean; hint?: string };

export interface ModuleDef {
  key: ModuleKey;
  name: string;
  description: string;
  /** Sti under holdet, fx "samkorsel" -> /hold/<id>/samkorsel. */
  path: string;
  fields: readonly ConfigField[];
  /** Falsk indtil modulet er bygget. Moduler der ikke er klar kan ikke slås til. */
  available: boolean;
}

export type Registry = Readonly<Record<string, ModuleDef>>;

export const MODULES: Registry = {
  carpool: {
    key: "carpool",
    name: "Samkørsel",
    description: "Hvem kører, hvem mangler en lift, og hvor mødes vi. Pr. kamp eller aktivitet.",
    path: "samkorsel",
    fields: [],
    available: false,
  },
  tasks: {
    key: "tasks",
    name: "Frugt og opgaver",
    description: "Frugtliste, oprydning og kridtning fordelt retfærdigt på familierne.",
    path: "opgaver",
    fields: [],
    available: false,
  },
  fines: {
    key: "fines",
    name: "Bødekasse",
    description: "Holdets egen bødekasse med aldersgrænse. Satserne bestemmer holdet selv.",
    path: "bodekasse",
    fields: [
      {
        key: "minAge",
        label: "Mindste alder for at få en bøde",
        type: "int",
        min: 6,
        max: 18,
        default: 12,
        hint: "Spillere under denne alder kan ikke få bøder.",
      },
    ],
    available: false,
  },
};

export type ModuleConfig = Record<string, number | boolean>;

export function defaultConfig(def: ModuleDef): ModuleConfig {
  return Object.fromEntries(def.fields.map((f) => [f.key, f.default]));
}

/**
 * Validerer indstillinger. Ukendte felter smides væk.
 * Fra en formular (`form`) betyder et manglende afkrydsningsfelt "fra", fordi en ikke-afkrydset
 * checkbox slet ikke sendes. Fra databasen (`stored`) betyder manglende felt "standardværdien".
 */
export function parseConfig(def: ModuleDef, raw: Record<string, unknown>, source: "form" | "stored" = "stored"): ModuleConfig {
  const out: ModuleConfig = {};
  for (const f of def.fields) {
    const v = raw[f.key];
    if (f.type === "bool") {
      out[f.key] = v === undefined ? (source === "form" ? false : f.default) : v === true || v === "on" || v === "true";
    } else {
      if (v === undefined || v === null || v === "") {
        out[f.key] = f.default;
        continue;
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        throw new Error(`${f.label} skal være et helt tal mellem ${f.min} og ${f.max}.`);
      }
      out[f.key] = n;
    }
  }
  return out;
}
