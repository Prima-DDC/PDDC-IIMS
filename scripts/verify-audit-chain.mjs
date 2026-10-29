// Walks the audit hash chain and reports whether it is intact (PRD 13, 20.2).
//
// Three things are checked, and they are not the same thing:
//
//   1. Every row's `row_hash` is sha256(prev_hash || canonical_row), which is
//      what `audit.verify_chain` recomputes. A row altered in place fails
//      here, and so does every row after it.
//   2. `audit.chain_head` agrees with the last row. The head is what new
//      inserts chain onto, so a head that has drifted means either a row was
//      removed from the end or the head itself was edited.
//   3. The most recent off-system anchor still matches the chain at the point
//      it was taken. This is the only check that means anything against an
//      actor who can rewrite the whole chain, which on hosted Supabase
//      includes the `postgres` role: see docs/architecture.md section 4 for
//      why the honest claim is tamper-EVIDENT rather than tamper-proof
//      against the platform administrator.
//
// Run it with:
//   npm run verify:audit-chain
//   npm run verify:audit-chain -- --anchor     also records a new anchor
//
// `--anchor` records the current head in `audit.chain_anchors` with status
// `pending`. Publishing that anchor somewhere outside this project is the part
// that makes it evidence, and it needs pg_cron (M7); until then an anchor is a
// local witness only, and this script says so rather than implying otherwise.

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

const ANCHOR = process.argv.includes("--anchor");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is not set. Run this through npm so .env.local is loaded:\n` +
        "  npm run verify:audit-chain",
    );
    process.exit(1);
  }
  return value;
}

const client = new pg.Client({
  connectionString: requireEnv("SUPABASE_DB_URL"),
  ssl: supabaseSsl(),
  application_name: "pddc-iims-verify-chain",
});

const failures = [];
const notes = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await client.connect();

  // ----------------------------------------------------------------- 1. rows
  const { rows: chain } = await client.query("select * from audit.verify_chain(0)");
  const result = chain[0];

  if (!result || result.checked === "0" || result.checked === 0) {
    notes.push("The audit log is empty, so there is no chain to verify yet.");
  } else {
    assert(
      result.ok,
      `The chain is broken. The first bad entry is seq ${result.first_bad_seq} ` +
        `(${result.first_bad_id}). Entries before it are intact; that one and ` +
        "everything after it cannot be relied on.",
    );
    if (result.ok) {
      notes.push(`${result.checked} entries recomputed and verified.`);
    }
  }

  // ----------------------------------------------------------------- 2. head
  const { rows: head } = await client.query(
    "select last_hash, entry_count, updated_at from audit.chain_head",
  );
  const { rows: last } = await client.query(
    "select seq, audit_id, row_hash, occurred_at from audit.audit_log order by seq desc limit 1",
  );
  const { rows: counted } = await client.query(
    "select count(*)::bigint as n from audit.audit_log",
  );

  if (head.length === 0) {
    failures.push("audit.chain_head is missing. New entries cannot chain onto anything.");
  } else if (last.length === 0) {
    assert(
      head[0].last_hash === "0".repeat(64),
      "The log is empty but the chain head is not the genesis hash, which means " +
        "entries were removed from the end.",
    );
  } else {
    assert(
      head[0].last_hash === last[0].row_hash,
      `The chain head does not match the last entry. Head says ` +
        `${head[0].last_hash.slice(0, 16)}, the last entry (seq ${last[0].seq}) is ` +
        `${last[0].row_hash.slice(0, 16)}. Either an entry was removed from the ` +
        "end or the head was edited.",
    );
    assert(
      String(head[0].entry_count) === String(counted[0].n),
      `The chain head counts ${head[0].entry_count} entries but the log holds ` +
        `${counted[0].n}.`,
    );
    notes.push(
      `Head at seq ${last[0].seq}, ${counted[0].n} entries, last written ` +
        `${new Date(last[0].occurred_at).toISOString()}.`,
    );
  }

  // --------------------------------------------------------------- 3. anchors
  const { rows: anchors } = await client.query(
    "select anchor_id, anchored_at, head_hash, entry_count, export_status, exported_to " +
      "from audit.chain_anchors order by anchored_at desc limit 1",
  );

  if (anchors.length === 0) {
    notes.push(
      "No off-system anchor has been recorded. Hash chaining alone does not " +
        "detect an actor who rewrites the whole chain, so this is the gap that " +
        "matters: see docs/architecture.md section 4.",
    );
  } else {
    const anchor = anchors[0];
    // The anchor witnesses the chain as it was at `entry_count` entries, so it
    // is compared against the chain at that point rather than against the head.
    const { rows: atAnchor } = await client.query(
      "select row_hash from audit.audit_log order by seq asc offset ($1::bigint - 1) limit 1",
      [anchor.entry_count],
    );

    if (atAnchor.length === 0) {
      failures.push(
        `The most recent anchor witnesses ${anchor.entry_count} entries, but the ` +
          `log now holds fewer. Entries have been removed.`,
      );
    } else {
      assert(
        atAnchor[0].row_hash === anchor.head_hash,
        `The chain no longer matches the anchor taken at ` +
          `${new Date(anchor.anchored_at).toISOString()}. The log has been ` +
          "rewritten behind that point.",
      );
    }

    notes.push(
      `Most recent anchor: ${anchor.entry_count} entries, ` +
        `${new Date(anchor.anchored_at).toISOString()}, export ` +
        `${anchor.export_status}${anchor.exported_to ? ` to ${anchor.exported_to}` : ""}.`,
    );
    if (anchor.export_status !== "exported") {
      notes.push(
        "That anchor has not been published outside this project, so it is a " +
          "local witness only. Scheduled export needs pg_cron (M7).",
      );
    }
  }

  // --------------------------------------------------------- optional anchor
  if (ANCHOR && failures.length === 0 && head.length > 0 && last.length > 0) {
    const { rows: created } = await client.query(
      "insert into audit.chain_anchors (head_hash, entry_count) values ($1, $2) " +
        "returning anchor_id",
      [head[0].last_hash, head[0].entry_count],
    );
    notes.push(
      `Recorded anchor ${created[0].anchor_id} at ${head[0].entry_count} entries, ` +
        "status pending. Publish it outside this project for it to count as evidence.",
    );
  } else if (ANCHOR && failures.length > 0) {
    notes.push("No anchor was recorded, because the chain did not verify.");
  }

  // ---------------------------------------------------------------- report
  for (const note of notes) console.log(`note: ${note}`);

  if (failures.length > 0) {
    console.error(`\nFAILED: the audit trail is not intact:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }

  console.log("\nPASS: the audit hash chain is unbroken and the head agrees with it.");
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
