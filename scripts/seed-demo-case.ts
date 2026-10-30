/**
 * Plants the fixtures for PRD 20.1's acceptance demo, and removes them again.
 *
 *   npm run seed:demo          create
 *   npm run seed:demo -- clean remove
 *
 * WHAT IT DOES AND DELIBERATELY DOES NOT DO.
 *
 * PRD 20.1 asks for a demonstration of twenty-six steps, carried out in the
 * browser, from creating a client to reviewing the audit trail. So this does
 * not create the case: creating it is step 4, and a seed that had already
 * done the demonstration would prove nothing. What it plants is the two
 * things the walkthrough cannot produce for itself.
 *
 * THE NEAR-MATCHES, so step 3's conflict check has something to find. PRD
 * 20.2 names the pairs that must be flagged: "John Mensah / John K. Mensah"
 * and "ABC Holdings Ltd / ABC Holdings Ghana Limited". A screening run
 * against an empty register correctly finds nothing, and a demonstration of
 * nothing is not a demonstration of conflict screening. These records are
 * therefore planted as EXISTING history: a former client and a subject from
 * an earlier case, which is what a real conflict is.
 *
 * A RETIRED CLIENT with a similar name, so the screening result shows a match
 * against a client as well as against a subject. The two come from different
 * tables and PRD 8.3 asks for both.
 *
 * Everything it writes carries a marker in its notes so it can be found and
 * removed, and `clean` soft-deletes exactly those records and nothing else.
 * The marker is in the notes rather than in the name because the names have
 * to be screened as themselves: see MARKER below. It refuses to run at all
 * without DEMO_ALLOW_SEED=1, because this writes to the live project that
 * also serves primaddc.com.
 *
 * docs/acceptance-demo.md is the walkthrough itself, step by step.
 */

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

/**
 * How a fixture is recognised, for the clean step.
 *
 * In the NOTES rather than in the name, which matters more than it looks.
 * Prefixing the names with "DEMO " was the first version and it distorted the
 * very thing the fixtures exist to demonstrate: conflict screening works on
 * normalised names, so an added word changes every similarity score and adds
 * a token that two unrelated fixtures then share. "ABC Holdings Ghana
 * Limited" has to be screened as itself for the demonstration to mean
 * anything.
 */
const MARKER = "[PRD 20.1 acceptance demonstration fixture]";

interface ClientFixture {
  name: string;
  type: string;
  status: string;
  note: string;
}

interface EntityFixture {
  name: string;
  type: string;
  aliases: string[];
  note: string;
}

/**
 * The records the demo screens against.
 *
 * Both halves of each PRD 20.2 pair are here except the one the demonstrator
 * types in: "ABC Insurance Ltd" and "John Mensah" are entered by hand during
 * the walkthrough, and these are what they collide with.
 */
const CLIENTS: ClientFixture[] = [
  {
    name: "ABC Holdings Ghana Limited",
    type: "corporate",
    status: "dormant",
    note:
      "A former client, retained for conflict screening. PRD 20.2 requires " +
      "ABC Holdings Ltd / ABC Holdings Ghana Limited to be flagged as a " +
      "potential match, and a screening run needs something to match against.",
  },
  {
    name: "ABC Insurance Brokers Ltd",
    type: "corporate",
    status: "dormant",
    note:
      "A second near-match, closer still to the name the demonstration " +
      "enters. Two matches rather than one, so the screen shows a list and a " +
      "manager has a decision to make rather than a formality to confirm.",
  },
];

const ENTITIES: EntityFixture[] = [
  {
    name: "John K. Mensah",
    type: "person",
    aliases: ["John Mensah", "J. K. Mensah"],
    note:
      "A subject from an earlier matter. PRD 20.2's other required pair: the " +
      "demonstration enters John Mensah and this is what it finds.",
  },
  {
    name: "Kwabena Mensah",
    type: "person",
    aliases: [],
    note:
      "Deliberately NOT a match. A screening run that flags every surname " +
      "would be useless, and the demonstration should show the threshold " +
      "working rather than only that it fires.",
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. See .env.example.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const cleaning = process.argv.includes("clean");

  if (process.env.DEMO_ALLOW_SEED !== "1") {
    console.error(
      "Refusing to run. This writes to the live Supabase project that also\n" +
        "serves primaddc.com, so it needs DEMO_ALLOW_SEED=1 to be set\n" +
        "deliberately:\n\n" +
        "  DEMO_ALLOW_SEED=1 npm run seed:demo\n",
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-demo-seed",
  });
  await client.connect();

  try {
    const { rows: admins } = await client.query<{ id: string }>(
      `select u.id
       from iam.users u
       join iam.user_roles ur on ur.user_id = u.id
       join iam.roles r on r.id = ur.role_id
       where r.key = 'administrator' and u.status = 'active' and u.deleted_at is null
       order by u.created_at
       limit 1`,
    );

    if (admins.length === 0) {
      console.error(
        "No active administrator to attribute the fixtures to. Run\n" +
          "`npm run create-admin` first.",
      );
      process.exit(1);
    }
    const actor = admins[0].id;

    // Everything runs as that administrator, so the audit trail attributes
    // the fixtures to a real person rather than to nobody. A demonstration
    // whose own setup is unattributed would be the one gap in the trail the
    // last step is meant to show.
    await client.query("begin");
    await client.query("select set_config('iims.user_id', $1, true)", [actor]);
    await client.query(
      "select set_config('iims.clearance', 'STRICTLY_RESTRICTED', true)",
    );
    await client.query("select set_config('iims.request_id', $1, true)", [
      crypto.randomUUID(),
    ]);
    await client.query("select set_config('iims.aal', 'aal2', true)");

    if (cleaning) {
      await remove(client);
    } else {
      await plant(client, actor);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function plant(client: pg.Client, actor: string): Promise<void> {
  let planted = 0;
  let skipped = 0;

  for (const fixture of CLIENTS) {
    const { rows } = await client.query<{ client_id: string }>(
      `insert into crm.clients
         (organisation_name, client_type, client_risk_rating, active_status,
          classification, notes, created_by, updated_by)
       values ($1, $2, 'low', $3, 'INTERNAL', $4, $5::uuid, $5::uuid)
       on conflict do nothing
       returning client_id`,
      [
        fixture.name,
        fixture.type,
        fixture.status,
        `${MARKER} ${fixture.note}`,
        actor,
      ],
    );

    if (rows.length === 0) {
      // Already there from an earlier run. Not an error: the seed is meant to
      // be safe to run again before a demonstration.
      skipped += 1;
      continue;
    }
    planted += 1;
    console.log(`  client   ${rows[0].client_id}  ${fixture.name}`);
  }

  for (const fixture of ENTITIES) {
    const { rows } = await client.query<{ id: string; entity_id: string }>(
      `insert into intel.entities
         (name, entity_type, classification, notes, created_by, updated_by)
       values ($1, $2, 'INTERNAL', $3, $4::uuid, $4::uuid)
       on conflict do nothing
       returning id, entity_id`,
      [fixture.name, fixture.type, `${MARKER} ${fixture.note}`, actor],
    );

    if (rows.length === 0) {
      skipped += 1;
      continue;
    }
    planted += 1;
    console.log(`  subject  ${rows[0].entity_id}  ${fixture.name}`);

    for (const alias of fixture.aliases) {
      await client.query(
        `insert into intel.entity_aliases
           (entity_id, alias, alias_type, source_note, created_by)
         values ($1::uuid, $2, 'also_known_as', $3, $4::uuid)
         on conflict do nothing`,
        [
          rows[0].id,
          alias,
          "Planted for the PRD 20.1 acceptance demonstration.",
          actor,
        ],
      );
      console.log(`           alias  ${alias}`);
    }
  }

  console.log(
    `\n${planted} fixture(s) planted, ${skipped} already present.\n\n` +
      "Now walk docs/acceptance-demo.md. Step 1 creates ABC Insurance Ltd and\n" +
      "step 3 screens it, which is where these records are found.\n",
  );
}

async function remove(client: pg.Client): Promise<void> {
  // Soft-deleted, not erased, because that is what the platform does to
  // everything else and because the audit trail of the demonstration should
  // keep pointing at records that still exist.
  const clients = await client.query(
    `update crm.clients
     set deleted_at = now()
     where notes like $1 and deleted_at is null`,
    [`${MARKER}%`],
  );

  const entities = await client.query(
    `update intel.entities
     set deleted_at = now()
     where notes like $1 and deleted_at is null`,
    [`${MARKER}%`],
  );

  console.log(
    `${clients.rowCount} client(s) and ${entities.rowCount} subject(s) withdrawn.\n` +
      "They are in the recycle bin rather than gone, which is what every\n" +
      "other deletion in this platform does.\n",
  );
}

// `main().catch(...)` rather than a top-level await: tsx compiles these
// scripts to CommonJS, where top-level await is not available.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
