/**
 * Registers the scheduled jobs, once the platform is deployed.
 *
 *   CRON_ALLOW_SCHEDULE=1 IIMS_PUBLIC_URL=https://iims.primaddc.com \
 *     npm run schedule:jobs
 *
 *   npm run schedule:jobs -- --list      show what is scheduled
 *   CRON_ALLOW_SCHEDULE=1 npm run schedule:jobs -- --remove
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. A migration runs wherever the
 * migrations run, and this needs something a migration cannot have: the URL
 * the platform is actually deployed at. Hard-coding a guess would schedule
 * four jobs posting into nowhere, and `cron.job_run_details` would fill with
 * failures that look like the workers are broken. So it is a deliberate step
 * taken after a deployment, and `--list` is how you check it was taken.
 *
 * WHAT EACH JOB DOES, which is nothing except make an HTTP request.
 *
 * A cron job runs as the role that scheduled it, which here is `postgres`:
 * the owner of every table, able to bypass its own policies and write to the
 * audit trail. Doing the work inside the database would mean doing it with
 * full privileges and no audit identity. So every job body is a single
 * `net.http_post` to a route handler, which connects back as `iims_app`
 * under a named system process and does the work under the normal controls.
 * The route handlers are in `src/app/api/cron/`.
 *
 * THE SECRET LIVES IN VAULT, read inside the job body. A secret in a job
 * body is a secret in `cron.job`, which is readable by anybody who can read
 * that catalogue; `vault.decrypted_secrets` is not, and `iims_app` is
 * explicitly denied it.
 */

import pg from "pg";
import { supabaseSsl } from "./_db-ssl.mjs";

const SECRET_NAME = "iims_cron_worker_secret";

/**
 * The schedule, and the reasoning for each interval.
 *
 * Every one of them is a trade between how fresh the answer needs to be and
 * how much of a free-tier allowance it spends. A minute-level job is ~43,000
 * invocations a month, which is comfortable against the 500,000 the free tier
 * allows, and four of them is not.
 */
const JOBS = [
  {
    name: "iims-drain-notifications",
    schedule: "* * * * *",
    path: "/api/cron/notify",
    why:
      "Every minute. PRD 20.2 asks for email within two minutes of the event, " +
      "and the outbox holds the durable record either way, so the only cost " +
      "of a minute's delay is the delay.",
  },
  {
    name: "iims-scan-overdue",
    schedule: "*/15 * * * *",
    path: "/api/cron/scan",
    why:
      "Every fifteen minutes. Two of the three scans are about days, and the " +
      "third decides the interval: PRD 5.8 asks for an immediate alert on a " +
      "missed safety check-in, and a quarter of an hour is the honest reading " +
      "of immediate for something found by looking rather than by anybody " +
      "reporting it. A minute-level scan would mostly find nothing.",
  },
  {
    name: "iims-run-ai-queue",
    schedule: "*/5 * * * *",
    path: "/api/cron/ai",
    why:
      "Every five minutes, and inert until a provider is allow-listed. Free " +
      "tiers are limited per minute and per day, so a tighter schedule spends " +
      "the day's allowance on the morning and a looser one makes the " +
      "assistant feel broken.",
  },
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const listing = process.argv.includes("--list");
  const removing = process.argv.includes("--remove");

  if (!listing && process.env.CRON_ALLOW_SCHEDULE !== "1") {
    console.error(
      [
        "Refusing to run.",
        "",
        "This enables two extensions and schedules jobs on the live Supabase",
        "project that also serves primaddc.com, so it needs",
        "CRON_ALLOW_SCHEDULE=1 to be set deliberately:",
        "",
        "  CRON_ALLOW_SCHEDULE=1 IIMS_PUBLIC_URL=https://iims.primaddc.com \\",
        "    npm run schedule:jobs",
        "",
        "`npm run schedule:jobs -- --list` needs nothing and changes nothing.",
      ].join("\n"),
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: requireEnv("SUPABASE_DB_URL"),
    ssl: supabaseSsl(),
    application_name: "pddc-iims-schedule",
  });
  await client.connect();

  try {
    if (listing) {
      await list(client);
      return;
    }
    if (removing) {
      await remove(client);
      return;
    }
    await schedule(client);
  } finally {
    await client.end();
  }
}

async function list(client) {
  const { rows: ready } = await client.query(
    `select exists (
       select 1 from pg_extension where extname = 'pg_cron'
     ) as cron,
     exists (
       select 1 from pg_extension where extname = 'pg_net'
     ) as net`,
  );

  console.log(
    `pg_cron ${ready[0].cron ? "installed" : "NOT installed"}, ` +
      `pg_net ${ready[0].net ? "installed" : "NOT installed"}`,
  );

  if (!ready[0].cron) {
    console.log("\nNothing is scheduled, because pg_cron is not installed.\n");
    return;
  }

  const { rows } = await client.query(
    `select jobname, schedule, active from cron.job
     where jobname like 'iims-%' order by jobname`,
  );

  if (rows.length === 0) {
    console.log("\nNo IIMS jobs are scheduled.\n");
    return;
  }

  console.log("");
  for (const row of rows) {
    console.log(
      `  ${row.jobname.padEnd(28)} ${row.schedule.padEnd(14)} ${
        row.active ? "active" : "PAUSED"
      }`,
    );
  }

  // The last run of each, because "scheduled" and "working" are different
  // things and this is the difference.
  const { rows: runs } = await client.query(
    `select j.jobname, d.status, d.return_message, d.start_time
     from cron.job j
     left join cron.job_run_details d on d.jobid = j.jobid
     where j.jobname like 'iims-%'
       and d.start_time = (
         select max(start_time) from cron.job_run_details x where x.jobid = j.jobid
       )
     order by j.jobname`,
  );

  if (runs.length > 0) {
    console.log("\n  last run:");
    for (const row of runs) {
      console.log(
        `  ${row.jobname.padEnd(28)} ${String(row.status).padEnd(10)} ${
          row.start_time ? new Date(row.start_time).toISOString() : "never"
        }${row.return_message ? `  ${row.return_message.slice(0, 80)}` : ""}`,
      );
    }
  }
  console.log("");
}

async function schedule(client) {
  const base = requireEnv("IIMS_PUBLIC_URL").replace(/\/$/, "");
  const secret = requireEnv("CRON_WORKER_SECRET");

  if (!base.startsWith("https://")) {
    console.error(
      `IIMS_PUBLIC_URL is ${base}. It has to be https: the secret travels in a header.`,
    );
    process.exit(1);
  }

  // Both in the `extensions` schema, which is where Supabase puts everything
  // except pg_cron: that one insists on its own `cron` schema.
  await client.query("create extension if not exists pg_cron");
  await client.query(
    "create extension if not exists pg_net with schema extensions",
  );

  // Stored once, replaced on a re-run, so rotating the secret is this script
  // again rather than a manual edit.
  await client.query(
    `select case
       when exists (select 1 from vault.secrets where name = $1)
         then vault.update_secret(
                (select id from vault.secrets where name = $1), $2, $1,
                'Shared secret the IIMS cron jobs present to their route handlers.')::text
       else vault.create_secret(
                $2, $1,
                'Shared secret the IIMS cron jobs present to their route handlers.')::text
     end`,
    [SECRET_NAME, secret],
  );

  for (const job of JOBS) {
    /*
     * The body reads the secret from Vault at run time rather than carrying
     * it. `cron.job` is readable by anybody who can read that catalogue, and
     * a secret in a job body is a secret in a catalogue.
     *
     * `timeout_milliseconds` is raised from pg_net's 2-second default:
     * draining the outbox sends up to twenty-five emails over SMTP, and a
     * worker cut off halfway leaves its leased rows to expire, which is
     * correct but slow. The request is fired and forgotten either way, so the
     * timeout only decides how long pg_net waits for a reply it discards.
     */
    const body = `
      select extensions.http_post(
        url     := ${quote(`${base}${job.path}`)},
        headers := jsonb_build_object(
          'content-type', 'application/json',
          'x-cron-secret', (
            select decrypted_secret from vault.decrypted_secrets
            where name = ${quote(SECRET_NAME)}
          )
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 55000
      )
    `.trim();

    await client.query(
      `select cron.schedule($1, $2, $3)`,
      [job.name, job.schedule, body],
    );

    console.log(`  scheduled ${job.name.padEnd(28)} ${job.schedule}`);
  }

  /*
   * Housekeeping, and it is not optional.
   *
   * `cron.job_run_details` is never pruned by pg_cron and grows with every
   * run: four jobs at minute and quarter-hour intervals is roughly sixty
   * thousand rows a month, and an unpruned copy of it has blocked Postgres
   * upgrades before. `config.prune_expired_counters` does the same for the
   * idempotency keys and rate-limit windows.
   */
  await client.query(
    `select cron.schedule(
       'iims-prune',
       '17 3 * * *',
       $$
         delete from cron.job_run_details where end_time < now() - interval '7 days';
         select set_config('iims.system_process', 'prune', true);
         select config.prune_expired_counters();
       $$
     )`,
  );
  console.log(`  scheduled ${"iims-prune".padEnd(28)} 17 3 * * *`);

  console.log(
    [
      "",
      "Done. Check it with:",
      "",
      "  npm run schedule:jobs -- --list",
      "",
      "which shows each job's last run. A job that is scheduled and failing",
      "looks exactly like one that is working until you look at that.",
      "",
    ].join("\n"),
  );
}

async function remove(client) {
  const { rows } = await client.query(
    `select jobname from cron.job where jobname like 'iims-%'`,
  );

  for (const row of rows) {
    await client.query("select cron.unschedule($1)", [row.jobname]);
    console.log(`  unscheduled ${row.jobname}`);
  }

  if (rows.length === 0) console.log("Nothing to remove.");
}

/** A SQL string literal, for the one place a parameter cannot go. */
function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
