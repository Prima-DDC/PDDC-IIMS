import "server-only";
import { can, requireActor } from "@/lib/auth/session";
import { casework } from "@/modules/casework";
import type {
  WorkflowStage,
  WorkflowTransition,
} from "@/modules/casework/shared";

/** Read model for the lifecycle administration screen (PRD 4.3). */

export interface StageRow {
  stage: WorkflowStage;
  /** The moves out of this stage, in the order the case screen offers them. */
  transitions: WorkflowTransition[];
  /** Live cases sitting here now, which is what makes a change risky. */
  cases: number;
  /** True when nothing leads here, so no case could ever reach it. */
  unreachable: boolean;
}

export async function getWorkflowAdmin() {
  const actor = await requireActor();

  const api = casework(actor);

  const definition = await api.workflow.defaultDefinition();

  const [usage, caseTypes, mayConfigure, perStage] = await Promise.all([
    api.workflow.stageUsage(definition.id),
    api.workflow.caseTypes(true),
    can(actor, "settings", "configure"),
    Promise.all(
      definition.stages.map(async (stage) => ({
        stage,
        transitions: await api.workflow.transitionsFrom(stage.id),
      })),
    ),
  ]);

  const countFor = (stageId: string) =>
    usage.find((entry) => entry.stageId === stageId)?.cases ?? 0;

  // A stage nothing leads to is a stage no case can reach. Worth saying on
  // the screen, because it is the usual result of adding one and stopping.
  const destinations = new Set(
    perStage.flatMap((entry) => entry.transitions.map((t) => t.toStageId)),
  );
  const first = [...definition.stages].sort(
    (a, b) => a.position - b.position,
  )[0];

  const stages: StageRow[] = perStage
    .map((entry) => ({
      stage: entry.stage,
      transitions: entry.transitions,
      cases: countFor(entry.stage.id),
      unreachable:
        entry.stage.id !== first?.id && !destinations.has(entry.stage.id),
    }))
    .sort((a, b) => a.stage.position - b.stage.position);

  return {
    definition,
    stages,
    caseTypes,
    totalCases: usage.reduce((sum, entry) => sum + entry.cases, 0),
    can: { configure: mayConfigure },
  };
}
