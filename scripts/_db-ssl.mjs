// Pinned TLS trust anchor for Supabase Postgres connections.
//
// Supabase signs its Postgres certificates with its own "Supabase Root 2021
// CA", which Node does not ship in its trust store: so a plain connection
// fails with SELF_SIGNED_CERT_IN_CHAIN. The documented fix is to pin that CA,
// NOT to set rejectUnauthorized: false (which would accept any certificate and
// leave the connection open to interception).
//
// certs/supabase-prod-ca.crt
//   subject : CN=Supabase Root 2021 CA, O=Supabase Inc
//   sha256  : 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
//             82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
//   expires : 2031-04-26
//
// Verify the file against the dashboard download (Database Settings -> SSL
// Configuration) if the fingerprint ever stops matching: that means the CA was
// rotated, not that verification should be relaxed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { X509Certificate } from "node:crypto";

const CA_PATH = path.resolve("certs/supabase-prod-ca.crt");
const EXPECTED_SHA256 =
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA";

let cached;

/** TLS options for `pg` / `postgres.js`, with the Supabase CA pinned. */
export function supabaseSsl() {
  if (cached) return cached;

  let ca;
  try {
    ca = readFileSync(CA_PATH);
  } catch {
    console.error(
      `Missing ${CA_PATH}.\n` +
        "Download it from the Supabase dashboard (Database Settings -> SSL Configuration)\n" +
        "or from https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt",
    );
    process.exit(1);
  }

  // Fail loudly if the pinned CA is not the one we reviewed.
  const cert = new X509Certificate(ca);
  if (cert.fingerprint256 !== EXPECTED_SHA256) {
    console.error(
      `CA fingerprint mismatch.\n  expected ${EXPECTED_SHA256}\n  found    ${cert.fingerprint256}\n` +
        "Re-download from the Supabase dashboard and update EXPECTED_SHA256 after reviewing.",
    );
    process.exit(1);
  }

  cached = { ca, rejectUnauthorized: true };
  return cached;
}
