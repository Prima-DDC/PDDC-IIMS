"use client";

import { useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Flag,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Id,
  Input,
  Muted,
  Select,
  Table,
  Td,
  Textarea,
  Th,
} from "@/components/ui";
import {
  METHODOLOGY_LABELS,
  METHODOLOGY_STAGES,
  type CaseType,
  type WorkflowDefinition,
} from "@/modules/casework/shared";
import type { StageRow } from "./queries";
import {
  addStage,
  addTransition,
  moveStage,
  removeTransition,
  renameStage,
  saveCaseType,
  setCaseTypeActive,
} from "./actions";

/**
 * The lifecycle, as an administrator sees and changes it (PRD 4.3).
 *
 * The screen is built to make the consequences visible before the change: how
 * many live cases sit in each stage, which stages nothing leads to, and which
 * routes exist out of each. PRD 4.3 asks for a configurable lifecycle, and a
 * configuration screen without those three things is how somebody strands
 * fifty cases on a Friday afternoon.
 */

export function LifecyclePanel({
  definition,
  stages,
  totalCases,
  canConfigure,
}: {
  definition: WorkflowDefinition;
  stages: StageRow[];
  totalCases: number;
  canConfigure: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [routing, setRouting] = useState<string | null>(null);

  const unreachable = stages.filter((row) => row.unreachable);
  const dead = stages.filter(
    (row) => !row.stage.isTerminal && row.transitions.length === 0,
  );

  return (
    <Card
      title={`Case lifecycle: ${definition.name}`}
      description="The stages a case moves through, and the moves each stage allows. Read by every case screen, so a change here changes all of them."
      actions={
        canConfigure && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add a stage
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-muted">
          {stages.length} stages, {totalCases}{" "}
          {totalCases === 1 ? "live case" : "live cases"} across them. A stage
          cannot be deleted: cases and audit entries point at it, so it is
          retired by taking away the routes into it instead.
        </p>

        {unreachable.length > 0 && (
          <Alert tone="warn" title="Nothing leads to these stages">
            {unreachable.map((row) => row.stage.name).join(", ")}. No case can
            reach them until something moves into them.
          </Alert>
        )}

        {dead.length > 0 && (
          <Alert tone="danger" title="These stages have no way out">
            {dead
              .map(
                (row) =>
                  `${row.stage.name}${row.cases > 0 ? ` (${row.cases} live)` : ""}`,
              )
              .join(", ")}
            . A case that arrives there cannot be moved on. Either add a route
            or mark the stage terminal.
          </Alert>
        )}

        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Add a stage</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={addStage}
              submitLabel="Add the stage"
              submitSize="sm"
              hidden={{ definitionId: definition.id }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Key"
                    htmlFor="stage-key"
                    required
                    hint="Permanent. It appears in permission grants and saved filters, so it cannot be changed later."
                    error={state.fieldErrors?.key}
                  >
                    <Input id="stage-key" name="key" placeholder="peer_review" />
                  </Field>

                  <Field
                    label="Name"
                    htmlFor="stage-name"
                    required
                    hint="What people read. This can be changed whenever."
                    error={state.fieldErrors?.name}
                  >
                    <Input id="stage-name" name="name" placeholder="Peer Review" />
                  </Field>

                  <Field
                    label="Methodology stage"
                    htmlFor="stage-methodology"
                    hint="Which part of the PRD 4.3 methodology this belongs to, so tasks file under the right one."
                    error={state.fieldErrors?.methodologyStage}
                  >
                    <Select id="stage-methodology" name="methodologyStage" defaultValue="">
                      <option value="">Not part of one</option>
                      {METHODOLOGY_STAGES.map((stage) => (
                        <option key={stage} value={stage}>
                          {METHODOLOGY_LABELS[stage]}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  <div className="space-y-2">
                    <label className="flex items-center gap-2 text-xs text-body">
                      <input
                        type="checkbox"
                        name="isTerminal"
                        className="size-4 rounded border-line"
                      />
                      A case stops here (terminal)
                    </label>
                    <label className="flex items-center gap-2 text-xs text-body">
                      <input
                        type="checkbox"
                        name="requiresApproval"
                        className="size-4 rounded border-line"
                      />
                      Entering it needs an approval
                    </label>
                  </div>

                  <div className="sm:col-span-2">
                    <Field
                      label="What happens at this stage"
                      htmlFor="stage-description"
                      error={state.fieldErrors?.description}
                    >
                      <Textarea id="stage-description" name="description" rows={2} />
                    </Field>
                  </div>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        <ol className="space-y-2">
          {stages.map((row, index) => (
            <li
              key={row.stage.id}
              className={`rounded-lg border p-3 ${
                row.unreachable || (!row.stage.isTerminal && row.transitions.length === 0)
                  ? "border-warn/40 bg-warn/5"
                  : "border-line"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] tabular-nums text-faint">
                  {index + 1}
                </span>
                <span className="text-xs font-semibold text-body">
                  {row.stage.name}
                </span>
                <Id>{row.stage.key}</Id>
                {row.stage.isTerminal && (
                  <Badge tone="neutral">
                    <Flag className="size-3" aria-hidden="true" />
                    Terminal
                  </Badge>
                )}
                {row.stage.requiresApproval && (
                  <Badge tone="info">
                    <ShieldCheck className="size-3" aria-hidden="true" />
                    Approval to enter
                  </Badge>
                )}
                {row.stage.methodologyStage && (
                  <Muted>
                    {METHODOLOGY_LABELS[
                      row.stage.methodologyStage as keyof typeof METHODOLOGY_LABELS
                    ] ?? row.stage.methodologyStage}
                  </Muted>
                )}
                <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                  {row.cases} {row.cases === 1 ? "case" : "cases"} here
                </span>
              </div>

              {row.stage.description && (
                <p className="mt-1.5 text-[11px] text-muted">
                  {row.stage.description}
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {row.transitions.length === 0 ? (
                  row.stage.isTerminal ? (
                    <Muted>Nothing leaves a terminal stage.</Muted>
                  ) : (
                    <Muted>No way out of this stage.</Muted>
                  )
                ) : (
                  row.transitions.map((transition) => (
                    <span
                      key={transition.id}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-body"
                    >
                      <ArrowRight className="size-3 text-faint" aria-hidden="true" />
                      {transition.toStageName}
                      {transition.requiredPermission && (
                        <Muted>needs {transition.requiredPermission}</Muted>
                      )}
                      {canConfigure && (
                        <ActionForm
                          action={removeTransition}
                          submitLabel={
                            <>
                              <Trash2 className="size-3" aria-hidden="true" />
                              <span className="sr-only">
                                Remove the route to {transition.toStageName}
                              </span>
                            </>
                          }
                          submitTone="ghost"
                          submitSize="sm"
                          hidden={{
                            transitionId: transition.id,
                            definitionId: definition.id,
                          }}
                          confirm={`Remove the route from ${row.stage.name} to ${transition.toStageName}?`}
                          compact
                          className="contents"
                        />
                      )}
                    </span>
                  ))
                )}
              </div>

              {canConfigure && (
                <div className="mt-2 flex flex-wrap justify-end gap-1.5">
                  <ActionForm
                    action={moveStage}
                    submitLabel={
                      <>
                        <ArrowUp className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">Move {row.stage.name} earlier</span>
                      </>
                    }
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{
                      definitionId: definition.id,
                      stageId: row.stage.id,
                      direction: "up",
                    }}
                    compact
                    className="contents"
                  />
                  <ActionForm
                    action={moveStage}
                    submitLabel={
                      <>
                        <ArrowDown className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">Move {row.stage.name} later</span>
                      </>
                    }
                    submitTone="ghost"
                    submitSize="sm"
                    hidden={{
                      definitionId: definition.id,
                      stageId: row.stage.id,
                      direction: "down",
                    }}
                    compact
                    className="contents"
                  />
                  <Button
                    size="sm"
                    tone="ghost"
                    onClick={() =>
                      setRenaming(renaming === row.stage.id ? null : row.stage.id)
                    }
                  >
                    Rename
                  </Button>
                  {!row.stage.isTerminal && (
                    <Button
                      size="sm"
                      tone="ghost"
                      onClick={() =>
                        setRouting(routing === row.stage.id ? null : row.stage.id)
                      }
                    >
                      Add a route
                    </Button>
                  )}
                </div>
              )}

              {renaming === row.stage.id && (
                <div className="mt-2 border-t border-line pt-2">
                  <ActionForm
                    action={renameStage}
                    submitLabel="Rename"
                    submitSize="sm"
                    hidden={{ stageId: row.stage.id }}
                  >
                    {(state) => (
                      <Field
                        label="New name"
                        htmlFor={`rename-${row.stage.id}`}
                        required
                        error={state.fieldErrors?.name}
                      >
                        <Input
                          id={`rename-${row.stage.id}`}
                          name="name"
                          defaultValue={row.stage.name}
                        />
                      </Field>
                    )}
                  </ActionForm>
                </div>
              )}

              {routing === row.stage.id && (
                <div className="mt-2 border-t border-line pt-2">
                  <ActionForm
                    action={addTransition}
                    submitLabel="Add the route"
                    submitSize="sm"
                    hidden={{
                      definitionId: definition.id,
                      fromStageId: row.stage.id,
                    }}
                  >
                    {(state) => (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field
                          label="To"
                          htmlFor={`route-to-${row.stage.id}`}
                          required
                          error={state.fieldErrors?.toStageId}
                        >
                          <Select
                            id={`route-to-${row.stage.id}`}
                            name="toStageId"
                            defaultValue=""
                          >
                            <option value="">Choose a stage</option>
                            {stages
                              .filter(
                                (other) =>
                                  other.stage.id !== row.stage.id &&
                                  !row.transitions.some(
                                    (t) => t.toStageId === other.stage.id,
                                  ),
                              )
                              .map((other) => (
                                <option key={other.stage.id} value={other.stage.id}>
                                  {other.stage.name}
                                </option>
                              ))}
                          </Select>
                        </Field>

                        <Field
                          label="Permission needed"
                          htmlFor={`route-perm-${row.stage.id}`}
                          hint="As resource:action. Empty means the ordinary cases:edit."
                          error={state.fieldErrors?.requiredPermission}
                        >
                          <Input
                            id={`route-perm-${row.stage.id}`}
                            name="requiredPermission"
                            placeholder="cases:approve"
                          />
                        </Field>

                        <div className="flex items-end">
                          <label className="flex items-center gap-2 text-xs text-body">
                            <input
                              type="checkbox"
                              name="requiresReason"
                              defaultChecked
                              className="size-4 rounded border-line"
                            />
                            Demand a typed reason
                          </label>
                        </div>
                      </div>
                    )}
                  </ActionForm>
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------- case types */

export function CaseTypesPanel({
  caseTypes,
  canConfigure,
}: {
  caseTypes: CaseType[];
  canConfigure: boolean;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card
      title="Case types"
      description="What kind of investigation a case is. Offered on the new-case form, and used to file the methodology."
      actions={
        canConfigure && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Add a type
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {adding && (
          <div className="rounded-lg border border-line bg-surface-sunken p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-medium text-body">Add a case type</p>
              <Button size="sm" tone="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" aria-hidden="true" />
                Cancel
              </Button>
            </div>
            <ActionForm
              action={saveCaseType}
              submitLabel="Save the type"
              submitSize="sm"
              hidden={{ isActive: "on" }}
            >
              {(state) => (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    label="Key"
                    htmlFor="type-key"
                    required
                    hint="Permanent, and stored on every case of this type."
                    error={state.fieldErrors?.key}
                  >
                    <Input id="type-key" name="key" placeholder="asset_tracing" />
                  </Field>
                  <Field
                    label="Name"
                    htmlFor="type-name"
                    required
                    error={state.fieldErrors?.name}
                  >
                    <Input id="type-name" name="name" placeholder="Asset Tracing" />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field
                      label="What it covers"
                      htmlFor="type-description"
                      error={state.fieldErrors?.description}
                    >
                      <Textarea id="type-description" name="description" rows={2} />
                    </Field>
                  </div>
                </div>
              )}
            </ActionForm>
          </div>
        )}

        {caseTypes.length === 0 ? (
          <EmptyState
            title="No case types"
            description="A case cannot be opened without one, so add at least one."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Key</Th>
                <Th>Offered for new cases</Th>
                <Th className="text-right">Change</Th>
              </tr>
            </thead>
            <tbody>
              {caseTypes.map((type) => (
                <tr key={type.key}>
                  <Td>
                    <span className="text-xs font-medium text-body">{type.name}</span>
                    {type.description && (
                      <p className="max-w-80 text-[11px] text-faint">
                        {type.description}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <Id>{type.key}</Id>
                  </Td>
                  <Td>
                    {type.isActive ? (
                      <Badge tone="ok">Offered</Badge>
                    ) : (
                      <Badge tone="neutral">Retired</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    {canConfigure && (
                      <div className="flex justify-end">
                        <ActionForm
                          action={setCaseTypeActive}
                          submitLabel={type.isActive ? "Retire" : "Offer again"}
                          submitSize="sm"
                          hidden={{
                            key: type.key,
                            isActive: type.isActive ? "false" : "true",
                          }}
                          confirm={
                            type.isActive
                              ? `Retire ${type.name}? Cases already using it keep it.`
                              : undefined
                          }
                          compact
                        />
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>
    </Card>
  );
}
