import { createHmac } from "node:crypto";

// The code an authenticator app shows (RFC 6238: HMAC-SHA1, 30-second steps, six digits), so a test can play the app.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  let bits = "";
  for (const char of clean) bits += ALPHABET.indexOf(char).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// The code for the 30-second step that is `offset` steps from now. A code is good once and only for a newer step than the last
// one used, so after one was used the next that works is a step later (the server also accepts one step ahead).
export function totpCode(secret: string, offset = 0, now = Date.now()): string {
  const step = Math.floor(now / 1000 / 30) + offset;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const start = mac[mac.length - 1] & 0x0f;
  const value = mac.readUInt32BE(start) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}
