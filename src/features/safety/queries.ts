import "server-only";
import { canAll, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import { classificationLevels, staffDirectory } from "@/lib/reference";

/** Read models for the safety panel and the field screen (PRD 5.8, screen 25). */

export async function getCaseSafety(caseRecordId: string) {
  const actor = await requireActor();

  const api = casework(actor);

  const [plan, latest, recent, incidents, summary, allowed, directory, levels] =
    await Promise.all([
      api.safety.planForCase(caseRecordId),
      // Who is out there now: the latest event for each person.
      api.safety.listCheckIns({
        caseId: caseRecordId,
        latestPerUser: true,
        limit: 50,
      }),
      api.safety.listCheckIns({ caseId: caseRecordId, limit: 30 }),
      api.safety.listIncidents({
        caseId: caseRecordId,
        status: "all",
        limit: 50,
      }),
      api.safety.safetySummary({ caseId: caseRecordId }),
      canAll(actor, [
        { resource: "cases", action: "edit" },
        { resource: "cases", action: "view" },
      ]),
      staffDirectory(actor),
      classificationLevels(actor),
    ]);

  return {
    plan,
    /** One row per person, so the panel can say who has not come back. */
    whoIsOut: latest.rows.filter((c) => c.event === "check_in"),
    recentCheckIns: recent.rows,
    incidents: incidents.rows,
    summary,
    levels,
    people: directory,
    actorId: actor.userId,
    can: {
      edit: allowed["cases:edit"],
      view: allowed["cases:view"],
    },
  };
}

/**
 * The field screen (PRD screen 25).
 *
 * Built around one question: which case am I on, and am I due to check in?
 * So it reads the cases this person is assigned to rather than every case
 * they could see, and the check-ins are their own.
 */
export async function getFieldView() {
  const actor = await requireActor();

  const api = casework(actor);

  const [assigned, myCheckIns, myIncidents] = await Promise.all([
    api.cases.list({ assignedTo: actor.userId, openness: "open", limit: 50 }),
    api.safety.listCheckIns({
      userId: actor.userId,
      latestPerUser: true,
      limit: 50,
    }),
    api.safety.listIncidents({
      affectedUserId: actor.userId,
      openOnly: true,
      limit: 20,
    }),
  ]);

  // The safety plan for each case, which is what tells somebody in the field
  // the hazards and who to ring. One query per case, run together: these are
  // the handful of cases one person is on, not a list that grows.
  const plans = await Promise.all(
    assigned.rows.map(async (record) => ({
      caseRecordId: record.id,
      plan: await api.safety.planForCase(record.id),
    })),
  );
  const planByCase = new Map(plans.map((p) => [p.caseRecordId, p.plan]));
  const latestByCase = new Map(myCheckIns.rows.map((c) => [c.caseId, c]));

  return {
    actorId: actor.userId,
    cases: assigned.rows.map((record) => ({
      id: record.id,
      caseId: record.caseId,
      title: record.title,
      clientName: record.clientName,
      classification: record.classification,
      plan: planByCase.get(record.id) ?? null,
      latest: latestByCase.get(record.id) ?? null,
    })),
    myOpenIncidents: myIncidents.rows,
  };
}
