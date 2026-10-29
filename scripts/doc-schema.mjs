#!/usr/bin/env node
/**
 * Writes docs/erd.md and docs/permission-matrix.md from the live database.
 *
 * Generated rather than hand-written, for one reason: a hand-written ERD is
 * wrong the first time somebody adds a column and does not notice. PRD 20.3
 * asks for an ERD and a permission matrix as deliverables, and a deliverable
 * that disagrees with the database is worse than none, because somebody will
 * design against it.
 *
 *   node --env-file=.env.local scripts/doc-schema.mjs
 *
 * Read-only: it opens a transaction, reads the catalogue and rolls back.
 */

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";

const CA = readFileSync("certs/supabase-prod-ca.crt");
// Every IIMS schema that holds tables today. The three still to come
// (intel, reporting, notify) are listed so the document grows with the build
// rather than needing to be remembered; a schema with no tables yet simply
// contributes nothing.
const SCHEMAS = [
  "iam",
  "crm",
  "casework",
  "evidence",
  "docs",
  "intel",
  "reporting",
  "notify",
  "config",
  "audit",
];

const client = new pg.Client({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: { ca: CA, rejectUnauthorized: true },
  application_name: "pddc-iims-doc-schema",
});

const SCHEMA_NOTES = {
  iam: "Who people are, what they may do, and the evidence of both.",
  crm: "Clients, the engagements PDDC commits to, and the intake that precedes them.",
  casework:
    "The case record: the work, the plan, the log, safety and the commercials.",
  config: "Things an administrator changes without a release.",
  audit: "The hash-chained trail. Append-only for every application role.",
};

function mermaidName(schema, table) {
  return `${schema}__${table}`;
}

async function main() {
  await client.connect();
  await client.query("begin read only");

  const { rows: tables } = await client.query(
    `select table_schema as schema, table_name as name
     from information_schema.tables
     where table_schema = any($1) and table_type = 'BASE TABLE'
     order by table_schema, table_name`,
    [SCHEMAS],
  );

  const { rows: columns } = await client.query(
    `select c.table_schema as schema, c.table_name as table, c.column_name as name,
            c.data_type, c.is_nullable, c.column_default,
            exists (
              select 1 from information_schema.table_constraints tc
              join information_schema.key_column_usage k
                on k.constraint_name = tc.constraint_name
               and k.table_schema = tc.table_schema
              where tc.constraint_type = 'PRIMARY KEY'
                and tc.table_schema = c.table_schema
                and tc.table_name = c.table_name
                and k.column_name = c.column_name
            ) as is_pk
     from information_schema.columns c
     where c.table_schema = any($1)
     order by c.table_schema, c.table_name, c.ordinal_position`,
    [SCHEMAS],
  );

  const { rows: fks } = await client.query(
    `select
       con.conname as name,
       src_ns.nspname as src_schema, src.relname as src_table,
       tgt_ns.nspname as tgt_schema, tgt.relname as tgt_table,
       (select string_agg(a.attname, ', ' order by u.ord)
          from unnest(con.conkey) with ordinality u(attnum, ord)
          join pg_attribute a on a.attrelid = src.oid and a.attnum = u.attnum
       ) as src_columns,
       con.confdeltype as on_delete
     from pg_constraint con
     join pg_class src on src.oid = con.conrelid
     join pg_namespace src_ns on src_ns.oid = src.relnamespace
     join pg_class tgt on tgt.oid = con.confrelid
     join pg_namespace tgt_ns on tgt_ns.oid = tgt.relnamespace
     where con.contype = 'f' and src_ns.nspname = any($1)
     order by src_ns.nspname, src.relname, con.conname`,
    [SCHEMAS],
  );

  const { rows: policyCounts } = await client.query(
    `select schemaname as schema, tablename as table, count(*)::int as policies
     from pg_policies where schemaname = any($1)
     group by 1, 2`,
    [SCHEMAS],
  );

  const { rows: rls } = await client.query(
    `select n.nspname as schema, c.relname as table,
            c.relrowsecurity as enabled, c.relforcerowsecurity as forced
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and c.relkind = 'r'`,
    [SCHEMAS],
  );

  const { rows: comments } = await client.query(
    `select n.nspname as schema, c.relname as table,
            obj_description(c.oid, 'pg_class') as note
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = any($1) and c.relkind = 'r'`,
    [SCHEMAS],
  );

  /* ------------------------------------------------------------ the ERD */

  const by = (rows, schema, table) =>
    rows.filter((r) => r.schema === schema && r.table === table);

  const noteFor = (schema, table) =>
    comments.find((c) => c.schema === schema && c.table === table)?.note ?? null;

  const erd = [];
  erd.push("# Entity relationship diagram");
  erd.push("");
  erd.push(
    "Generated from the live database by `node --env-file=.env.local scripts/doc-schema.mjs`.",
  );
  erd.push("Do not edit by hand: re-run it after a migration instead.");
  erd.push("");
  erd.push(`Read on ${new Date().toISOString().slice(0, 10)}.`);
  erd.push("");

  erd.push("## Contents");
  erd.push("");
  for (const schema of SCHEMAS) {
    const count = tables.filter((t) => t.schema === schema).length;
    erd.push(`- [\`${schema}\`](#${schema}): ${count} tables. ${SCHEMA_NOTES[schema] ?? ""}`);
  }
  erd.push("");

  for (const schema of SCHEMAS) {
    const schemaTables = tables.filter((t) => t.schema === schema);
    if (schemaTables.length === 0) continue;

    erd.push(`## ${schema}`);
    erd.push("");
    erd.push(SCHEMA_NOTES[schema] ?? "");
    erd.push("");

    // The diagram: keys and foreign keys only, so it stays readable. The
    // columns are in the table below it.
    erd.push("```mermaid");
    erd.push("erDiagram");
    for (const t of schemaTables) {
      const cols = by(columns, schema, t.name).filter(
        (c) => c.is_pk || fks.some(
          (f) => f.src_schema === schema && f.src_table === t.name &&
                 f.src_columns.split(", ").includes(c.name),
        ),
      );
      erd.push(`  ${mermaidName(schema, t.name)} {`);
      for (const c of cols) {
        const kind = c.is_pk ? "PK" : "FK";
        erd.push(`    ${c.data_type.replace(/[^a-z_]/g, "_")} ${c.name} ${kind}`);
      }
      erd.push("  }");
    }
    for (const f of fks.filter((f) => f.src_schema === schema)) {
      // A cascading delete is a composition; everything else is an
      // association that outlives its parent.
      const rel = f.on_delete === "c" ? "||--o{" : "}o--||";
      const [left, right] =
        f.on_delete === "c"
          ? [mermaidName(f.tgt_schema, f.tgt_table), mermaidName(schema, f.src_table)]
          : [mermaidName(schema, f.src_table), mermaidName(f.tgt_schema, f.tgt_table)];
      erd.push(`  ${left} ${rel} ${right} : "${f.src_columns}"`);
    }
    erd.push("```");
    erd.push("");

    for (const t of schemaTables) {
      const note = noteFor(schema, t.name);
      const guard = rls.find((r) => r.schema === schema && r.table === t.name);
      const policies =
        policyCounts.find((p) => p.schema === schema && p.table === t.name)?.policies ?? 0;

      erd.push(`### \`${schema}.${t.name}\``);
      erd.push("");
      if (note) erd.push(`${note}`);
      erd.push("");
      erd.push(
        `Row-level security: ${guard?.enabled ? "enabled" : "**off**"}` +
          `, ${guard?.forced ? "forced" : "**not forced**"}, ${policies} ` +
          `${policies === 1 ? "policy" : "policies"}.`,
      );
      erd.push("");
      erd.push("| Column | Type | Null | Default |");
      erd.push("| --- | --- | --- | --- |");
      for (const c of by(columns, schema, t.name)) {
        const name = c.is_pk ? `**${c.name}**` : c.name;
        const def = c.column_default
          ? `\`${String(c.column_default).replace(/\|/g, "\\|").slice(0, 60)}\``
          : "";
        erd.push(
          `| ${name} | ${c.data_type} | ${c.is_nullable === "YES" ? "yes" : "no"} | ${def} |`,
        );
      }
      erd.push("");

      const outbound = fks.filter(
        (f) => f.src_schema === schema && f.src_table === t.name,
      );
      if (outbound.length > 0) {
        erd.push("Points at:");
        erd.push("");
        for (const f of outbound) {
          const onDelete =
            f.on_delete === "c"
              ? ", cascading"
              : f.on_delete === "n"
                ? ", set null"
                : "";
          erd.push(
            `- \`${f.src_columns}\` to \`${f.tgt_schema}.${f.tgt_table}\`${onDelete}`,
          );
        }
        erd.push("");
      }
    }
  }

  writeFileSync("docs/erd.md", erd.join("\n"));

  /* ------------------------------------------------- the permission matrix */

  const { rows: grants } = await client.query(
    `select r.key as role, r.name as role_name, r.is_administrator,
            p.resource, p.action, p.scope, p.classification_ceiling as ceiling
     from iam.roles r
     join iam.role_permissions rp on rp.role_id = r.id
     join iam.permissions p on p.id = rp.permission_id
     where r.deleted_at is null
     order by r.key, p.resource, p.action`,
  );

  const roles = [...new Set(grants.map((g) => g.role))].sort();
  const resources = [...new Set(grants.map((g) => g.resource))].sort();
  const ACTION_LETTER = {
    view: "V",
    create: "C",
    edit: "E",
    upload: "U",
    download: "D",
    share: "S",
    approve: "A",
    delete: "X",
    export: "P",
    assign: "G",
    configure: "F",
    "*": "*",
  };

  const matrix = [];
  matrix.push("# Permission matrix");
  matrix.push("");
  matrix.push(
    "Generated from the live database by `node --env-file=.env.local scripts/doc-schema.mjs`.",
  );
  matrix.push(
    "This is what the platform actually enforces, not what was intended: it is read from `iam.roles`, `iam.role_permissions` and `iam.permissions`.",
  );
  matrix.push("");
  matrix.push(`Read on ${new Date().toISOString().slice(0, 10)}.`);
  matrix.push("");
  matrix.push(
    "PRD 16 is the starting set, and an administrator may change any cell through the permission builder, so this file is a snapshot rather than a specification.",
  );
  matrix.push("");
  matrix.push("Letters follow PRD 16:");
  matrix.push("");
  matrix.push(
    "**V** view, **C** create, **E** edit, **U** upload, **D** download, **S** share, **A** approve, **X** delete, **P** export, **G** assign, **F** configure, **\\*** everything.",
  );
  matrix.push("");
  matrix.push("A dash means no grant at all.");
  matrix.push("");

  matrix.push(`| Resource | ${roles.join(" | ")} |`);
  matrix.push(`| --- | ${roles.map(() => "---").join(" | ")} |`);
  for (const resource of resources) {
    const cells = roles.map((role) => {
      const held = grants.filter((g) => g.role === role && g.resource === resource);
      if (held.length === 0) return "-";
      const letters = [
        ...new Set(held.map((g) => ACTION_LETTER[g.action] ?? g.action)),
      ].join(" ");
      // The narrowest scope held, which is what limits the grant in practice.
      const scopes = [...new Set(held.map((g) => g.scope))];
      const scope = scopes.length === 1 && scopes[0] !== "all" ? ` (${scopes[0]})` : "";
      return `${letters}${scope}`;
    });
    matrix.push(`| ${resource} | ${cells.join(" | ")} |`);
  }
  matrix.push("");

  matrix.push("## Ceilings");
  matrix.push("");
  matrix.push(
    "A grant also carries the highest classification it reaches. The actor's own clearance applies on top, so the effective ceiling is the lower of the two.",
  );
  matrix.push("");
  matrix.push("| Role | Highest ceiling granted |");
  matrix.push("| --- | --- |");
  const RANK = {
    PUBLIC: 0,
    INTERNAL: 1,
    CONFIDENTIAL: 2,
    RESTRICTED: 3,
    STRICTLY_RESTRICTED: 4,
  };
  for (const role of roles) {
    const held = grants.filter((g) => g.role === role);
    const highest = held
      .map((g) => g.ceiling)
      .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0];
    matrix.push(`| ${role} | ${highest ?? ""} |`);
  }
  matrix.push("");

  writeFileSync("docs/permission-matrix.md", matrix.join("\n"));

  await client.query("rollback");
  await client.end();

  console.log(
    `docs/erd.md: ${tables.length} tables across ${SCHEMAS.length} schemas, ${fks.length} foreign keys.`,
  );
  console.log(
    `docs/permission-matrix.md: ${roles.length} roles, ${resources.length} resources, ${grants.length} grants.`,
  );
}

main().catch(async (error) => {
  console.error(error);
  await client.end().catch(() => {});
  process.exit(1);
});
