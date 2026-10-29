import { afterAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { testSql } from "../helpers/sql";
import { createCaseRepository } from "@/modules/casework/infrastructure/case-repository";
import { createSafetyRepository } from "@/modules/casework/infrastructure/safety-repository";
import { createFinanceRepository } from "@/modules/casework/infrastructure/finance-repository";
import { createClientRepository } from "@/modules/crm/infrastructure/client-repository";
import { createEngagementRepository } from "@/modules/crm/infrastructure/engagement-repository";
import { nextCheckInDue } from "@/modules/casework/domain/safety-policies";
import type { ActorContext } from "@/lib/db/client";

/**
 * Investigator safety, financials, time and expenses against the real
 * Postgres (PRD 5.6, 5.7, 5.8).
 *
 * Everything runs in a transaction that is always rolled back.
 *
 * What is worth proving here rather than in the domain tests is the part only
 * the database can answer: that a check-in genuinely cannot be edited, that
 * `outstanding` is computed by the database and cannot drift, that the CHECK
 * constraints refuse the states the rules refuse, that an approved time entry
 * is frozen, and that lateness is computed against the database's clock for
 * the latest check-in only.
 */

const hasDb = Boolean(process.env.SUPABASE_DB_URL);
const suite = describe.skipIf(!hasDb);

const sql = hasDb ? testSql() : null;

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

class Rollback extends Error {}

async function inRolledBackTx(
  body: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await sql!.begin(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
}

async function seedUser(
  tx: postgres.TransactionSql,
  roles: string[] = ["operations_manager"],
): Promise<string> {
  const [{ id }] = await tx<{ id: string }[]>`
    select extensions.gen_random_uuid() as id
  `;
  await tx`
    insert into auth.users
      (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    values (${id}::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated',
            'authenticated', ${`pddc-sf-${id}@example.invalid`}, 'fixture', now(), now())
  `;
  await tx`
    insert into iam.users (id, clearance, status)
    values (${id}::uuid, 'STRICTLY_RESTRICTED', 'active')
  `;
  for (const key of roles) {
    await tx`
      insert into iam.user_roles (user_id, role_id)
      select ${id}::uuid, r.id from iam.roles r where r.key = ${key}
    `;
  }
  return id;
}

function actorFor(userId: string): ActorContext {
  return {
    userId,
    clearance: "STRICTLY_RESTRICTED",
    requestId: crypto.randomUUID(),
    aal: "aal2",
    ip: "203.0.113.10",
    userAgent: "vitest",
  };
}

async function seedCase(
  tx: postgres.TransactionSql,
  actor: ActorContext,
  name: string,
) {
  const clients = createClientRepository(actor, tx);
  const engagements = createEngagementRepository(actor, tx);
  const cases = createCaseRepository(actor, tx);

  const client = await clients.create({
    organisationName: name,
    clientType: "corporate",
    riskRating: "medium",
    status: "active",
    classification: "CONFIDENTIAL",
  });
  const engagement = await engagements.create({
    clientId: client.id,
    title: `${name} engagement`,
    engagementType: "fraud_investigation",
    classification: "CONFIDENTIAL",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "pending_approval",
    reason: "ready",
  });
  await engagements.setStatus({
    id: engagement.id,
    status: "approved",
    reason: "approved for the test",
    approve: true,
  });

  return cases.create({
    title: `${name} case`,
    clientId: client.id,
    engagementId: engagement.id,
    caseType: "fraud_investigation",
    priority: "medium",
    classification: "CONFIDENTIAL",
  });
}

async function auditCount(
  tx: postgres.TransactionSql,
  recordId: string,
  action?: string,
): Promise<number> {
  const rows = await tx<{ n: string }[]>`
    select count(*) as n from audit.audit_log
    where record_id = ${recordId}
      and (${action ?? null}::text is null or action = ${action ?? null})
  `;
  return Number(rows[0].n);
}

/** A plain safety plan, with the check-in schedule PRD 5.8 asks for. */
const PLAN = {
  location: "Tema port, gate 3 car park",
  siteVisitRisk: "high" as const,
  knownHazards: "The subject's security staff have turned visitors away before.",
  safetyInstructions: "Two people at all times. Withdraw if challenged.",
  emergencyContactName: "Duty supervisor",
  emergencyContactPhone: "+233 30 000 0000",
  checkInFrequencyHours: 4,
  checkInInstructions: "Use the field screen or ring the office line.",
};

/* ----------------------------------------------------------- safety plans */

suite("safety plans", () => {
  it("records one plan per case, with its schedule", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Safety Co Ltd");
      const safety = createSafetyRepository(actor, tx);

      const plan = await safety.savePlan(record.id, PLAN);

      expect(plan.caseId).toBe(record.id);
      expect(plan.siteVisitRisk).toBe("high");
      expect(plan.checkInFrequencyHours).toBe(4);
      expect(plan.isActive).toBe(true);
      expect(plan.version).toBe(1);
      expect(await auditCount(tx, plan.id, "safety_plan.created")).toBe(1);
    });
  });

  it("refuses a second plan on the same case", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Safety Twice Ltd");
      const safety = createSafetyRepository(actor, tx);

      await safety.savePlan(record.id, PLAN);
      await expect(safety.savePlan(record.id, PLAN)).rejects.toThrow();
    });
  });

  it("refuses a schedule with no instructions, at the database too", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Safety Schedule Ltd");
      const safety = createSafetyRepository(actor, tx);

      // The domain rule says the same thing with a readable message; this is
      // the constraint that holds whatever calls the database.
      await expect(
        safety.savePlan(record.id, {
          ...PLAN,
          checkInInstructions: null,
        }),
      ).rejects.toThrow(/safety_plans_schedule_needs_instruction/);
    });
  });

  it("takes an edit with the version it was read at, and refuses a stale one", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Safety Version Ltd");
      const safety = createSafetyRepository(actor, tx);

      const plan = await safety.savePlan(record.id, PLAN);
      const updated = await safety.updatePlan(
        plan.id,
        { siteVisitRisk: "critical", isActive: false },
        plan.version,
      );

      expect(updated.siteVisitRisk).toBe("critical");
      expect(updated.isActive).toBe(false);
      expect(updated.version).toBe(plan.version + 1);
      expect(await auditCount(tx, plan.id, "safety_plan.updated")).toBe(1);

      await expect(
        safety.updatePlan(plan.id, { siteVisitRisk: "low" }, plan.version),
      ).rejects.toThrow(/changed since you opened it/);
    });
  });
});

/* ---------------------------------------------------------------- check-ins */

suite("check-ins", () => {
  it("allocates a CHK identifier and stores when the next one is due", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Check In Ltd");
      const safety = createSafetyRepository(actor, tx);

      const plan = await safety.savePlan(record.id, PLAN);
      const occurredAt = new Date().toISOString();

      const entry = await safety.recordCheckIn({
        caseId: record.id,
        userId,
        event: "check_in",
        occurredAt,
        location: "At the gate",
        nextDueAt: nextCheckInDue(plan, "check_in", occurredAt),
      });

      expect(entry.checkInId).toMatch(/^CHK-\d{4}-\d{6}$/);
      expect(entry.event).toBe("check_in");
      expect(entry.isSafe).toBe(true);
      expect(entry.nextDueAt).not.toBeNull();
      // Four hours after the check-in, from the plan's own interval.
      expect(
        new Date(entry.nextDueAt!).getTime() - new Date(occurredAt).getTime(),
      ).toBe(4 * 60 * 60 * 1000);
      expect(await auditCount(tx, entry.id, "check_in.recorded")).toBe(1);
    });
  });

  it("cannot be edited or deleted, by anybody", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Check In Immutable Ltd");
      const safety = createSafetyRepository(actor, tx);

      const entry = await safety.recordCheckIn({
        caseId: record.id,
        userId,
        event: "check_in",
        location: "At the gate",
      });

      // Run as `postgres`, the table owner, which is the strongest statement
      // this test can make: the trigger refuses it regardless of privilege.
      await tx`savepoint no_update`;
      await expect(
        tx`update casework.check_ins set location = 'somewhere else' where id = ${entry.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await tx`rollback to savepoint no_update`;

      await tx`savepoint no_delete`;
      await expect(
        tx`delete from casework.check_ins where id = ${entry.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await tx`rollback to savepoint no_delete`;
    });
  });

  it("refuses an unsafe check-in with nothing said", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Unsafe Ltd");
      const safety = createSafetyRepository(actor, tx);

      await expect(
        safety.recordCheckIn({
          caseId: record.id,
          userId,
          event: "check_in",
          isSafe: false,
        }),
      ).rejects.toThrow(/check_ins_unsafe_needs_a_note/);
    });
  });

  it("files an unsafe check-in under its own audit action", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Unsafe Audit Ltd");
      const safety = createSafetyRepository(actor, tx);

      const entry = await safety.recordCheckIn({
        caseId: record.id,
        userId,
        event: "check_in",
        isSafe: false,
        notes: "Two men have been following the vehicle since the port.",
      });

      // Its own action, so a search of the audit trail for safety alarms
      // finds them without reading every check-in.
      expect(await auditCount(tx, entry.id, "check_in.unsafe")).toBe(1);
      expect(await auditCount(tx, entry.id, "check_in.recorded")).toBe(0);
    });
  });

  it("counts only the latest check-in as late, and a check-out clears it", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Overdue Ltd");
      const safety = createSafetyRepository(actor, tx);
      await safety.savePlan(record.id, PLAN);

      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const halfAnHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const late = await safety.recordCheckIn({
        caseId: record.id,
        userId,
        event: "check_in",
        occurredAt: anHourAgo,
        // Due half an hour ago and nothing since, so this is overdue.
        nextDueAt: halfAnHourAgo,
      });

      const overdue = await safety.listCheckIns({
        caseId: record.id,
        overdueOnly: true,
      });
      expect(overdue.rows.map((r) => r.id)).toEqual([late.id]);
      expect(overdue.rows[0].minutesLate).toBeGreaterThanOrEqual(29);

      let summary = await safety.safetySummary({ caseId: record.id });
      expect(summary.peopleOut).toBe(1);
      expect(summary.overdueCheckIns).toBe(1);

      // Checking out ends the schedule: nobody is late for anything once they
      // have reported leaving.
      await safety.recordCheckIn({
        caseId: record.id,
        userId,
        event: "check_out",
      });

      expect(
        (await safety.listCheckIns({ caseId: record.id, overdueOnly: true })).rows,
      ).toHaveLength(0);

      summary = await safety.safetySummary({ caseId: record.id });
      expect(summary.peopleOut).toBe(0);
      expect(summary.overdueCheckIns).toBe(0);

      // And the superseded check-in is no longer reported as late either,
      // which is what the row_number in the projection is for.
      const all = await safety.listCheckIns({ caseId: record.id });
      expect(all.rows.every((r) => !r.isOverdue)).toBe(true);
    });
  });

  it("returns the latest event per person", async () => {
    await inRolledBackTx(async (tx) => {
      const one = await seedUser(tx);
      const two = await seedUser(tx, ["investigator"]);
      const actor = actorFor(one);
      const record = await seedCase(tx, actor, "E2E Latest Ltd");
      const safety = createSafetyRepository(actor, tx);

      await safety.recordCheckIn({ caseId: record.id, userId: one, event: "check_in" });
      await safety.recordCheckIn({ caseId: record.id, userId: two, event: "check_in" });
      const newest = await safety.recordCheckIn({
        caseId: record.id,
        userId: one,
        event: "check_out",
      });

      const latest = await safety.listCheckIns({
        caseId: record.id,
        latestPerUser: true,
      });
      expect(latest.rows).toHaveLength(2);
      expect(latest.rows.find((r) => r.userId === one)!.id).toBe(newest.id);
      expect(latest.rows.find((r) => r.userId === two)!.event).toBe("check_in");
    });
  });
});

/* ---------------------------------------------------------------- incidents */

const INCIDENT = {
  occurredAt: new Date("2026-10-01T14:30:00.000Z").toISOString(),
  incidentType: "threat" as const,
  severity: "high" as const,
  description:
    "Two men blocked the vehicle at the gate and told the team not to return.",
  classification: "CONFIDENTIAL" as const,
};

suite("incidents", () => {
  it("allocates an INC identifier and starts open", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Incident Ltd");
      const safety = createSafetyRepository(actor, tx);

      const incident = await safety.reportIncident({
        caseId: record.id,
        ...INCIDENT,
      });

      expect(incident.incidentId).toMatch(/^INC-\d{4}-\d{6}$/);
      expect(incident.status).toBe("open");
      expect(incident.caseReference).toBe(record.caseId);
      expect(incident.resolvedAt).toBeNull();
      expect(await auditCount(tx, incident.id, "incident.reported")).toBe(1);
    });
  });

  it("refuses injuries with no detail, and a police reference with no notification", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Incident Checks Ltd");
      const safety = createSafetyRepository(actor, tx);

      await tx`savepoint injuries`;
      await expect(
        safety.reportIncident({ caseId: record.id, ...INCIDENT, injuries: true }),
      ).rejects.toThrow(/incidents_injuries_need_detail/);
      await tx`rollback to savepoint injuries`;

      await tx`savepoint police`;
      await expect(
        safety.reportIncident({
          caseId: record.id,
          ...INCIDENT,
          policeReference: "CR/2026/4411",
        }),
      ).rejects.toThrow(/incidents_police_reference_needs_notification/);
      await tx`rollback to savepoint police`;
    });
  });

  it("needs a resolution to close, and records who closed it", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Incident Close Ltd");
      const safety = createSafetyRepository(actor, tx);

      const incident = await safety.reportIncident({
        caseId: record.id,
        ...INCIDENT,
      });

      await tx`savepoint no_resolution`;
      await expect(
        safety.setIncidentStatus({ id: incident.id, status: "closed" }),
      ).rejects.toThrow(/incidents_closed_needs_resolution/);
      await tx`rollback to savepoint no_resolution`;

      const closed = await safety.setIncidentStatus({
        id: incident.id,
        status: "closed",
        resolution: "Escorted off site, reported to the client, no further contact.",
      });

      expect(closed.status).toBe("closed");
      expect(closed.resolvedAt).not.toBeNull();
      expect(closed.resolvedBy).toBe(actor.userId);
      expect(await auditCount(tx, incident.id, "incident.closed")).toBe(1);
    });
  });

  it("clears the resolution stamp when an incident is reopened for review", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Incident Review Ltd");
      const safety = createSafetyRepository(actor, tx);

      const incident = await safety.reportIncident({
        caseId: record.id,
        ...INCIDENT,
      });
      const reviewing = await safety.setIncidentStatus({
        id: incident.id,
        status: "under_review",
      });

      // resolved_at is derived from the status rather than set by the caller,
      // so the two cannot disagree.
      expect(reviewing.status).toBe("under_review");
      expect(reviewing.resolvedAt).toBeNull();
      expect(reviewing.resolvedBy).toBeNull();
    });
  });

  it("lists the worst and newest first", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Incident Order Ltd");
      const safety = createSafetyRepository(actor, tx);

      await safety.reportIncident({ caseId: record.id, ...INCIDENT, severity: "low" });
      const critical = await safety.reportIncident({
        caseId: record.id,
        ...INCIDENT,
        severity: "critical",
      });

      const listed = await safety.listIncidents({ caseId: record.id });
      expect(listed.rows[0].id).toBe(critical.id);
      expect(listed.total).toBe(2);

      const summary = await safety.safetySummary({ caseId: record.id });
      expect(summary.openIncidents).toBe(2);
      expect(summary.criticalIncidents).toBe(1);
    });
  });
});

/* -------------------------------------------------------------- financials */

suite("case financials", () => {
  it("computes outstanding in the database", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Finance Ltd");
      const finance = createFinanceRepository(actor, tx);

      const financials = await finance.saveFinancials(record.id, {
        currency: "GHS",
        quotedFee: 12000,
        approvedFee: 11500,
        invoiceNumber: "INV-2026-001",
        amountInvoiced: 11500,
        amountPaid: 4000,
        paymentStatus: "part_paid",
      });

      // Not supplied by the caller: a generated column, so it cannot drift
      // from the two numbers it comes from.
      expect(financials.outstanding).toBe(7500);
      expect(financials.approvedFee).toBe(11500);
      expect(financials.currency).toBe("GHS");
      expect(await auditCount(tx, financials.id, "financials.created")).toBe(1);

      const paid = await finance.updateFinancials(
        financials.id,
        { amountPaid: 11500, paymentStatus: "paid" },
        financials.version,
      );
      expect(paid.outstanding).toBe(0);
      expect(paid.version).toBe(financials.version + 1);
    });
  });

  it("refuses more paid than invoiced, and an invoice with no number", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Finance Checks Ltd");
      const finance = createFinanceRepository(actor, tx);

      await tx`savepoint overpaid`;
      await expect(
        finance.saveFinancials(record.id, {
          invoiceNumber: "INV-1",
          amountInvoiced: 100,
          amountPaid: 400,
        }),
      ).rejects.toThrow(/case_financials_paid_within_invoiced/);
      await tx`rollback to savepoint overpaid`;

      await tx`savepoint no_number`;
      await expect(
        finance.saveFinancials(record.id, { amountInvoiced: 100 }),
      ).rejects.toThrow(/case_financials_invoiced_needs_a_number/);
      await tx`rollback to savepoint no_number`;

      await tx`savepoint no_note`;
      await expect(
        finance.saveFinancials(record.id, { paymentStatus: "written_off" }),
      ).rejects.toThrow(/case_financials_written_off_needs_a_note/);
      await tx`rollback to savepoint no_note`;
    });
  });

  it("holds one record per case", async () => {
    await inRolledBackTx(async (tx) => {
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Finance Once Ltd");
      const finance = createFinanceRepository(actor, tx);

      await finance.saveFinancials(record.id, { quotedFee: 500 });
      await expect(
        finance.saveFinancials(record.id, { quotedFee: 900 }),
      ).rejects.toThrow();
    });
  });
});

/* -------------------------------------------------------------------- time */

suite("time entries", () => {
  it("keeps hours and field days in their own units", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Time Ltd");
      const finance = createFinanceRepository(actor, tx);

      await finance.logTime({
        caseId: record.id,
        userId,
        workedOn: "2026-10-01",
        quantity: 7.5,
        unit: "hours",
        workKind: "investigation",
      });
      await finance.logTime({
        caseId: record.id,
        userId,
        workedOn: "2026-10-02",
        quantity: 2,
        unit: "days",
        workKind: "field_work",
      });
      await finance.logTime({
        caseId: record.id,
        userId,
        workedOn: "2026-10-03",
        quantity: 3,
        unit: "hours",
        workKind: "report_writing",
        isBillable: false,
      });

      const costs = await finance.costSummary(record.id);
      // Summed separately and never converted: PRD 5.7 asks for both units,
      // and a conversion needs a working-day length nobody has agreed.
      expect(costs.hours).toBe(10.5);
      expect(costs.days).toBe(2);
      expect(costs.billableHours).toBe(7.5);
    });
  });

  it("returns the worked date as a plain date, which a date input can use", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Time Date Ltd");
      const finance = createFinanceRepository(actor, tx);

      const entry = await finance.logTime({
        caseId: record.id,
        userId,
        workedOn: "2026-10-01",
        quantity: 4,
        unit: "hours",
        workKind: "analysis",
      });

      // A Date here instead of a string is what broke three edit forms, so
      // it is asserted rather than assumed.
      expect(typeof entry.workedOn).toBe("string");
      expect(entry.workedOn.slice(0, 10)).toBe("2026-10-01");
    });
  });

  it("freezes an entry once it is approved", async () => {
    await inRolledBackTx(async (tx) => {
      const worker = await seedUser(tx, ["investigator"]);
      const supervisor = await seedUser(tx);
      const actor = actorFor(supervisor);
      const record = await seedCase(tx, actor, "E2E Time Approval Ltd");
      const finance = createFinanceRepository(actor, tx);

      const entry = await finance.logTime({
        caseId: record.id,
        userId: worker,
        workedOn: "2026-10-01",
        quantity: 5,
        unit: "hours",
        workKind: "surveillance",
      });

      const approved = await finance.approveTimeEntry(entry.id);
      expect(approved.approvedAt).not.toBeNull();
      expect(approved.approvedBy).toBe(supervisor);
      expect(await auditCount(tx, entry.id, "time.approved")).toBe(1);

      await tx`savepoint frozen`;
      await expect(
        finance.updateTimeEntry(entry.id, { quantity: 9 }, approved.version),
      ).rejects.toThrow(/approved and cannot be changed/);
      await tx`rollback to savepoint frozen`;

      await tx`savepoint twice`;
      await expect(finance.approveTimeEntry(entry.id)).rejects.toThrow(
        /already approved/,
      );
      await tx`rollback to savepoint twice`;
    });
  });

  it("refuses hours that do not fit in a day", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Time Bounds Ltd");
      const finance = createFinanceRepository(actor, tx);

      await expect(
        finance.logTime({
          caseId: record.id,
          userId,
          workedOn: "2026-10-01",
          quantity: 30,
          unit: "hours",
          workKind: "investigation",
        }),
      ).rejects.toThrow(/time_entries_hours_fit_in_a_day/);
    });
  });

  it("filters by person, date and approval", async () => {
    await inRolledBackTx(async (tx) => {
      const one = await seedUser(tx);
      const two = await seedUser(tx, ["investigator"]);
      const actor = actorFor(one);
      const record = await seedCase(tx, actor, "E2E Time Filter Ltd");
      const finance = createFinanceRepository(actor, tx);

      await finance.logTime({
        caseId: record.id,
        userId: one,
        workedOn: "2026-09-01",
        quantity: 2,
        unit: "hours",
        workKind: "analysis",
      });
      const mine = await finance.logTime({
        caseId: record.id,
        userId: two,
        workedOn: "2026-10-05",
        quantity: 4,
        unit: "hours",
        workKind: "interview",
      });

      expect(
        (await finance.listTime({ caseId: record.id, userId: two })).rows.map(
          (r) => r.id,
        ),
      ).toEqual([mine.id]);

      expect(
        (await finance.listTime({ caseId: record.id, from: "2026-10-01" })).rows.map(
          (r) => r.id,
        ),
      ).toEqual([mine.id]);

      await finance.approveTimeEntry(mine.id);
      expect(
        (await finance.listTime({ caseId: record.id, unapprovedOnly: true })).total,
      ).toBe(1);
    });
  });
});

/* ---------------------------------------------------------------- expenses */

suite("expenses", () => {
  it("allocates an EXP identifier and starts claimed", async () => {
    await inRolledBackTx(async (tx) => {
      const userId = await seedUser(tx);
      const actor = actorFor(userId);
      const record = await seedCase(tx, actor, "E2E Expense Ltd");
      const finance = createFinanceRepository(actor, tx);

      const expense = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "travel",
        description: "Return flight to Kumasi for the site visit",
        amount: 1450.5,
        currency: "GHS",
        incurredBy: userId,
      });

      expect(expense.expenseId).toMatch(/^EXP-\d{4}-\d{6}$/);
      expect(expense.status).toBe("claimed");
      expect(expense.amount).toBe(1450.5);
      expect(expense.incurredOn.slice(0, 10)).toBe("2026-10-02");
      expect(await auditCount(tx, expense.id, "expense.claimed")).toBe(1);
    });
  });

  it("records a decision with its decider, and a rejection with its reason", async () => {
    await inRolledBackTx(async (tx) => {
      const claimant = await seedUser(tx, ["investigator"]);
      const approver = await seedUser(tx, ["finance"]);
      const actor = actorFor(approver);
      const record = await seedCase(tx, actor, "E2E Expense Decision Ltd");
      const finance = createFinanceRepository(actor, tx);

      const approvedClaim = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "records_and_searches",
        description: "Companies registry search fees",
        amount: 60,
        incurredBy: claimant,
      });
      const decided = await finance.decideExpense({
        id: approvedClaim.id,
        status: "approved",
      });

      expect(decided.status).toBe("approved");
      expect(decided.decidedBy).toBe(approver);
      expect(decided.decidedAt).not.toBeNull();
      expect(await auditCount(tx, approvedClaim.id, "expense.approved")).toBe(1);

      const rejectedClaim = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-03",
        category: "subsistence",
        description: "Dinner for four",
        amount: 900,
        incurredBy: claimant,
      });

      await tx`savepoint no_reason`;
      await expect(
        finance.decideExpense({ id: rejectedClaim.id, status: "rejected" }),
      ).rejects.toThrow(/expenses_rejection_needs_a_reason/);
      await tx`rollback to savepoint no_reason`;

      const rejected = await finance.decideExpense({
        id: rejectedClaim.id,
        status: "rejected",
        reason: "Outside the agreed scope and no receipt.",
      });
      expect(rejected.status).toBe("rejected");
      expect(rejected.decisionReason).toMatch(/Outside the agreed scope/);
    });
  });

  it("stops a claimant changing a decided claim", async () => {
    await inRolledBackTx(async (tx) => {
      const claimant = await seedUser(tx, ["investigator"]);
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Expense Frozen Ltd");
      const finance = createFinanceRepository(actor, tx);

      const claim = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "travel",
        description: "Taxi to the registry",
        amount: 40,
        incurredBy: claimant,
      });
      const approved = await finance.decideExpense({
        id: claim.id,
        status: "approved",
      });

      await expect(
        finance.updateExpense(claim.id, { amount: 400 }, approved.version),
      ).rejects.toThrow(/decided and cannot be changed/);
    });
  });

  it("totals what the case has cost, leaving rejected claims out", async () => {
    await inRolledBackTx(async (tx) => {
      const claimant = await seedUser(tx, ["investigator"]);
      const actor = actorFor(await seedUser(tx));
      const record = await seedCase(tx, actor, "E2E Expense Totals Ltd");
      const finance = createFinanceRepository(actor, tx);

      const billable = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "travel",
        description: "Flights",
        amount: 1000,
        incurredBy: claimant,
      });
      await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "equipment",
        description: "Replacement memory cards",
        amount: 150,
        isBillable: false,
        incurredBy: claimant,
      });
      const refused = await finance.claimExpense({
        caseId: record.id,
        incurredOn: "2026-10-02",
        category: "subsistence",
        description: "Dinner for four",
        amount: 900,
        incurredBy: claimant,
      });

      await finance.decideExpense({ id: billable.id, status: "approved" });
      await finance.decideExpense({
        id: refused.id,
        status: "rejected",
        reason: "Outside the agreed scope.",
      });

      const costs = await finance.costSummary(record.id);
      // A rejected claim is not a cost, and a non-billable one is a cost
      // PDDC carries rather than the client.
      expect(costs.expenseTotal).toBe(1150);
      expect(costs.billableExpenseTotal).toBe(1000);
      expect(costs.approvedExpenseTotal).toBe(1000);
      expect(costs.claimedExpenseCount).toBe(1);
    });
  });
});
