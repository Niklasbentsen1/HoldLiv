// To-faktor efter RFC 6238 (TOTP, 6 cifre, 30 sekunder, SHA-1), så den virker i alle autentificeringsapps.
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/[\s=]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Ugyldig hemmelighed");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20));

export const stepOf = (now: Date) => Math.floor(now.getTime() / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

/** Returnerer det step koden passer til (±1 step for urskævhed), ellers null. */
export function matchStep(secret: string, code: string, now = new Date()): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const cur = stepOf(now);
  for (const step of [cur, cur - 1, cur + 1]) if (codeAt(secret, step) === clean) return step;
  return null;
}

/** otpauth-adressen, som QR-koden i appen indeholder. */
export function otpauthUri(secret: string, email: string, issuer = "HoldLiv") {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// Hemmeligheden krypteres i databasen med AES-256-GCM, når TOTP_ENC_KEY (64 hex-tegn) er sat. Ellers gemmes den
// i klartekst i udvikling; i produktion kræves nøglen.
function key(): Buffer | null {
  const hex = process.env.TOTP_ENC_KEY;
  if (!hex) {
    if (process.env.NODE_ENV === "production") throw new Error("TOTP_ENC_KEY mangler");
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("TOTP_ENC_KEY skal være 64 hex-tegn");
  return Buffer.from(hex, "hex");
}

export function sealSecret(secret: string): string {
  const k = key();
  if (!k) return secret;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function openSecret(stored: string): string {
  if (!stored.startsWith("v1:")) return stored;
  const k = key();
  if (!k) throw new Error("TOTP_ENC_KEY mangler");
  const [, iv, tag, enc] = stored.split(":");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
}
