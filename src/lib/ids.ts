import { randomBytes } from "node:crypto";

// Crockford-style alphabet without ambiguous characters (no 0/O, 1/I/L).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function bookingReference() {
  const bytes = randomBytes(8);
  let out = "CB";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function ticketCode() {
  return randomBytes(24).toString("base64url");
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
