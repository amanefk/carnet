// Chiffrement du coffre — tout se passe dans le navigateur.
// PBKDF2-SHA256 (600 000 itérations) -> clé AES-256-GCM.
// Le mot de passe maître et la clé ne quittent jamais la page.

const enc = new TextEncoder();
const dec = new TextDecoder();
export const DEFAULT_ITERATIONS = 600_000;

export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function fromB64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

export async function deriveKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function newSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function encryptJSON(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(data)));
  return { iv: toB64(iv), ciphertext: toB64(ct) };
}

// Lève une erreur si le mot de passe est faux (tag GCM invalide)
export async function decryptJSON(key, ivB64, ctB64) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(ivB64) }, key, fromB64(ctB64));
  return JSON.parse(dec.decode(pt));
}

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%&*+-=?_.:;",
};
export function generatePassword(length = 20, { symbols = true } = {}) {
  const pools = [SETS.lower, SETS.upper, SETS.digits, ...(symbols ? [SETS.symbols] : [])];
  const all = pools.join("");
  const pick = (pool) => {
    // tirage sans biais de modulo
    const max = Math.floor(0x100000000 / pool.length) * pool.length;
    const buf = new Uint32Array(1);
    do crypto.getRandomValues(buf); while (buf[0] >= max);
    return pool[buf[0] % pool.length];
  };
  const out = pools.map(pick); // au moins un caractère de chaque famille
  while (out.length < length) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

// Estimation grossière, pour un indicateur visuel seulement
export function strength(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^a-zA-Z\d]/.test(pw)) pool += 20;
  const bits = pw.length * Math.log2(pool || 1);
  return bits < 40 ? 1 : bits < 65 ? 2 : bits < 90 ? 3 : 4;
}
