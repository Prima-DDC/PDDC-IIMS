"use server";

import { refreshPath } from "@/lib/revalidate";
import { EMPTY_FORM_STATE, invalidForm, type FormState } from "@/lib/forms";
import { requireActorOrThrow, requirePermission } from "@/lib/auth/session";
import { casework, isCaseworkError } from "@/modules/casework";
import { isIamError } from "@/modules/iam";
import {
  addStageSchema,
  addTransitionSchema,
  caseTypeActiveSchema,
  caseTypeSchema,
  removeTransitionSchema,
  renameStageSchema,
  reorderStagesSchema,
} from "./schema";

/**
 * Administering the case lifecycle (PRD 4.3).
 *
 * "The administrator can add, rename, reorder and retire stages without code
 * changes" is only true if there is somewhere to do it. The repository has
 * been able to do this since M3; this is the surface.
 *
 * Every action here guards the thing a configuration screen can do that no
 * other screen can: strand live work. Taking away the only route out of a
 * stage that holds cases would leave them with nowhere to go, and the refusal
 * says how many and where rather than reporting a constraint.
 */

async function run(work: () => Promise<FormState>): Promise<FormState> {
  try {
    return await work();
  } catch (error) {
    if (isCaseworkError(error) || isIamError(error)) {
      return { ...EMPTY_FORM_STATE, error: error.message };
    }
    console.error("workflow action failed", error);
    return {
      ...EMPTY_FORM_STATE,
      error: "Something went wrong saving that. Nothing was changed.",
    };
  }
}

function revalidateWorkflow() {
  refreshPath("/admin/workflows");
  // The lifecycle is read by the case register and every case page, so a
  // change here has to show up there without waiting for a cache to expire.
  refreshPath("/cases");
  refreshPath("/cases/[id]");
}

export async function addStage(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = addStageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { definitionId, ...input } = parsed.data;
    const api = casework(actor);

    const definition = await api.workflow.definition(definitionId);
    if (!definition) {
      return { ...EMPTY_FORM_STATE, error: "That lifecycle no longer exists." };
    }
    if (definition.stages.some((stage) => stage.key === input.key)) {
      return {
        ...EMPTY_FORM_STATE,
        error: `This lifecycle already has a stage keyed ${input.key}.`,
      };
    }

    // Added at the end. Moving it to where it belongs is a separate,
    // reversible step, which is safer than asking for a position up front and
    // renumbering everything around it on the first attempt.
    const position =
      Math.max(0, ...definition.stages.map((stage) => stage.position)) + 1;

    const stage = await api.workflow.createStage({
      definitionId,
      position,
      ...input,
    });

    revalidateWorkflow();
    return {
      ...EMPTY_FORM_STATE,
      success: `${stage.name} added at the end. Give it a route in and a route out, or no case will ever reach it.`,
    };
  });
}

export async function renameStage(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = renameStageSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const stage = await casework(actor).workflow.renameStage(
      parsed.data.stageId,
      parsed.data.name,
    );

    revalidateWorkflow();
    return {
      ...EMPTY_FORM_STATE,
      success: `Renamed to ${stage.name}. The key stays as it was, because permissions and saved filters use it.`,
    };
  });
}

/**
 * Moves a stage one place up or down.
 *
 * One step at a time rather than drag-and-drop, deliberately: the order of
 * the lifecycle decides what the progress rail shows on every case in the
 * platform, and a mis-drop would be a silent change to all of them.
 */
export async function moveStage(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = reorderStagesSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { definitionId, stageId, direction } = parsed.data;
    const api = casework(actor);

    const definition = await api.workflow.definition(definitionId);
    if (!definition) {
      return { ...EMPTY_FORM_STATE, error: "That lifecycle no longer exists." };
    }

    const ordered = [...definition.stages].sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((stage) => stage.id === stageId);
    if (index === -1) {
      return { ...EMPTY_FORM_STATE, error: "That stage is not in this lifecycle." };
    }

    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= ordered.length) {
      return {
        ...EMPTY_FORM_STATE,
        error: `${ordered[index].name} is already ${direction === "up" ? "first" : "last"}.`,
      };
    }

    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    await api.workflow.reorderStages(
      definitionId,
      ordered.map((stage) => stage.id),
    );

    revalidateWorkflow();
    return {
      ...EMPTY_FORM_STATE,
      success: `Moved ${ordered[target].name} ${direction}.`,
    };
  });
}

export async function addTransition(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = addTransitionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { definitionId, fromStageId, toStageId, ...input } = parsed.data;
    const api = casework(actor);

    const definition = await api.workflow.definition(definitionId);
    if (!definition) {
      return { ...EMPTY_FORM_STATE, error: "That lifecycle no longer exists." };
    }

    const from = definition.stages.find((stage) => stage.id === fromStageId);
    const to = definition.stages.find((stage) => stage.id === toStageId);
    if (!from || !to) {
      return { ...EMPTY_FORM_STATE, error: "Both stages have to be in this lifecycle." };
    }
    if (from.isTerminal) {
      return {
        ...EMPTY_FORM_STATE,
        error: `${from.name} is a terminal stage, which is the whole point of it: a case that reaches it has stopped. Clear the terminal flag first if that is wrong.`,
      };
    }

    await api.workflow.addTransition({
      definitionId,
      fromStageId,
      toStageId,
      ...input,
    });

    revalidateWorkflow();
    return {
      ...EMPTY_FORM_STATE,
      success: `${from.name} can now move to ${to.name}.`,
    };
  });
}

export async function removeTransition(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = removeTransitionSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const { transitionId, definitionId } = parsed.data;
    const api = casework(actor);

    const definition = await api.workflow.definition(definitionId);
    if (!definition) {
      return { ...EMPTY_FORM_STATE, error: "That lifecycle no longer exists." };
    }

    // Which stage this route leaves, and whether it is the last one out. One
    // query: asking `transitionsFrom` for all fourteen stages to find the
    // owner of one route is fourteen round trips for one answer.
    const route = await api.workflow.transition(transitionId);
    if (!route) {
      return { ...EMPTY_FORM_STATE, error: "That route no longer exists." };
    }

    if (!route.fromStageIsTerminal && route.siblingCount === 1) {
      const usage = await api.workflow.stageUsage(definitionId);
      const held = usage.find((u) => u.stageId === route.fromStageId)?.cases ?? 0;
      return {
        ...EMPTY_FORM_STATE,
        error:
          held > 0
            ? `This is the only way out of ${route.fromStageName}, and ${held} ${
                held === 1 ? "case is" : "cases are"
              } there now. Removing it would leave them with nowhere to go. Add another route first.`
            : `This is the only way out of ${route.fromStageName}, which is not terminal. Add another route first, or mark the stage terminal if a case is meant to stop there.`,
      };
    }

    await api.workflow.removeTransition(transitionId);

    revalidateWorkflow();
    return { ...EMPTY_FORM_STATE, success: "Route removed." };
  });
}

/* ----------------------------------------------------------- case types */

export async function saveCaseType(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = caseTypeSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    const type = await casework(actor).workflow.upsertCaseType(parsed.data);

    revalidateWorkflow();
    refreshPath("/cases/new");
    return { ...EMPTY_FORM_STATE, success: `${type.name} saved.` };
  });
}

export async function setCaseTypeActive(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(async () => {
    const actor = await requireActorOrThrow();
    await requirePermission(actor, "settings", "configure");

    const parsed = caseTypeActiveSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) return invalidForm(parsed.error);

    await casework(actor).workflow.setCaseTypeActive(
      parsed.data.key,
      parsed.data.isActive,
    );

    revalidateWorkflow();
    refreshPath("/cases/new");
    return {
      ...EMPTY_FORM_STATE,
      success: parsed.data.isActive
        ? "Type available again for new cases."
        : "Type retired. Cases already using it keep it, and it is no longer offered for new ones.",
    };
  });
}
