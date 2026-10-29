import { createHmac } from "node:crypto";

/**
 * A six-digit TOTP code, as RFC 6238 defines it and as every authenticator
 * app computes it.
 *
 * Twenty lines of node:crypto rather than a dependency: otplib v13 requires
 * explicit crypto and base32 plugins to be wired up, which is more moving
 * parts than a test helper needs, and the algorithm itself is fixed.
 *
 * Defaults match Supabase Auth: SHA-1, 30-second period, 6 digits.
 */
export function generateTotp(
  base32Secret: string,
  atMs: number = Date.now(),
): string {
  const key = base32Decode(base32Secret);

  const counter = Math.floor(atMs / 1000 / 30);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", key).update(counterBytes).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return String(binary % 1_000_000).padStart(6, "0");
}

/** RFC 4648 base32, ignoring padding and case, as TOTP secrets are encoded. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error(`Not a base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}
