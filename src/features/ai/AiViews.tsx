import { Bot, Lock, Quote, ShieldOff, Sparkles } from "lucide-react";
import { AppLink } from "@/components/AppLink";
import { ActionForm } from "@/components/ActionForm";
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Field,
  Id,
  Input,
  Muted,
  Select,
  Textarea,
} from "@/components/ui";
import type { AiJob, AiProvider } from "@/modules/ai/shared";
import {
  askAssistant,
  decideCaseAi,
  decideSuggestion,
  removeAiProvider,
  saveAiProvider,
} from "./actions";

/**
 * The assistant and the provider allow-list (PRD 22).
 *
 * Everything an AI output touches is visually distinct from the rest of the
 * platform, which PRD 22.3 asks for in as many words. The treatment is
 * consistent and deliberate: a dashed border, a label saying what it is, and
 * every statement shown with the references it rests on rather than as prose.
 * A suggestion should not be able to be mistaken for a finding at a glance,
 * because the whole risk of an assistant in an evidentiary platform is that
 * somebody quotes it as one.
 */

/* ---------------------------------------------------------- the assistant */

function SuggestionBody({ job }: { job: AiJob }) {
  if (job.status === "blocked") {
    return (
      <Alert tone="warn" title="Not sent">
        {job.blockedReason}
      </Alert>
    );
  }

  if (job.status === "failed") {
    return (
      <Alert tone="danger" title="No answer">
        {job.error ?? "The providers did not answer."}
      </Alert>
    );
  }

  if (job.status === "queued" || job.status === "running") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <span
          className="size-1.5 animate-pulse rounded-full bg-signal"
          aria-hidden="true"
        />
        {job.status === "queued"
          ? "Waiting for a provider. Reload in a moment."
          : "A provider is answering."}
      </p>
    );
  }

  const output = job.output;

  if (!output || output.statements.length === 0) {
    return (
      <Alert tone="info" title="Nothing it could support">
        The model produced nothing it could tie to a record on this case, so
        there is nothing to show. PRD 22.3 does not display an unsupported
        statement, and that is what every sentence it offered was.
        {output && output.discarded.length > 0 && (
          <span className="mt-1 block">
            {output.discarded.length} unsupported{" "}
            {output.discarded.length === 1 ? "sentence" : "sentences"} were
            discarded and are in the audit trail.
          </span>
        )}
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2.5">
        {output.statements.map((statement, index) => (
          <li key={index} className="text-sm leading-relaxed text-body">
            {statement.text}
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              <Quote className="size-3 text-faint" aria-hidden="true" />
              {statement.cites.map((reference) => (
                <Badge key={reference} tone="neutral">
                  {reference}
                </Badge>
              ))}
            </span>
          </li>
        ))}
      </ul>

      {output.notes && <Muted>{output.notes}</Muted>}

      {output.discarded.length > 0 && (
        <p className="text-[11px] text-muted">
          {output.discarded.length} further{" "}
          {output.discarded.length === 1 ? "sentence" : "sentences"} cited
          nothing on this case and {output.discarded.length === 1 ? "was" : "were"}{" "}
          discarded.
        </p>
      )}
    </div>
  );
}

function Decision({ job }: { job: AiJob }) {
  if (job.acceptedAt) {
    return (
      <p className="text-[11px] text-ok">
        Accepted by {job.acceptedByName ?? "somebody"} on{" "}
        {new Date(job.acceptedAt).toLocaleString()}
        {job.decisionNote ? `: ${job.decisionNote}` : ""}. It is not a finding
        until one is written.
      </p>
    );
  }

  if (job.rejectedAt) {
    return (
      <p className="text-[11px] text-muted">
        Rejected by {job.rejectedByName ?? "somebody"} on{" "}
        {new Date(job.rejectedAt).toLocaleString()}
        {job.decisionNote ? `: ${job.decisionNote}` : ""}.
      </p>
    );
  }

  if (job.status !== "succeeded" || !job.output?.statements.length) return null;

  return (
    <ActionForm
      action={decideSuggestion}
      submitLabel="Record decision"
      submitTone="secondary"
      submitSize="sm"
      pendingLabel="Recording"
      hidden={{ jobId: job.id }}
      compact
      className="mt-3 border-t border-dashed border-line pt-3"
    >
      {(state) => (
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Your judgement"
            htmlFor={`decision-${job.id}`}
            error={state.fieldErrors?.decision}
          >
            <Select id={`decision-${job.id}`} name="decision" defaultValue="accept">
              <option value="accept">Sound</option>
              <option value="reject">Reject</option>
            </Select>
          </Field>
          <Field
            label="Note"
            htmlFor={`note-${job.id}`}
            hint="Optional, and kept with the decision."
            error={state.fieldErrors?.note}
          >
            <Input id={`note-${job.id}`} name="note" />
          </Field>
        </div>
      )}
    </ActionForm>
  );
}

function JobCard({ job }: { job: AiJob }) {
  return (
    <li
      className="rounded-lg border border-dashed border-signal/40 bg-signal/4 p-3.5"
      data-ai-suggestion
      data-status={job.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="signal">
          <Sparkles className="size-3" aria-hidden="true" />
          AI-generated suggestion
        </Badge>
        <Muted>
          {new Date(job.createdAt).toLocaleString()}
          {job.model ? ` - ${job.model}` : ""}
          {job.cached ? " - from cache" : ""}
        </Muted>
      </div>

      {job.subject && (
        <p className="mt-2 text-xs font-medium text-muted">
          Asked: {job.subject}
        </p>
      )}

      <div className="mt-2.5">
        <SuggestionBody job={job} />
      </div>

      <Decision job={job} />
    </li>
  );
}

export function CaseAssistant({
  caseRecordId,
  view,
}: {
  caseRecordId: string;
  view: {
    mayView: boolean;
    mayAsk: boolean;
    mayDecideForCase: boolean;
    anyProvider: boolean;
    providerCount: number;
    setting: { isEnabled: boolean; reason: string; decidedByName: string | null; decidedAt: string; version: number } | null;
    isEnabledForCase: boolean;
    recent: AiJob[];
  };
}) {
  if (!view.mayView) return null;

  const settings = view.mayDecideForCase ? (
    <ActionForm
      action={decideCaseAi}
      submitLabel={view.isEnabledForCase ? "Save decision" : "Save decision"}
      submitTone="secondary"
      submitSize="sm"
      pendingLabel="Saving"
      hidden={{
        caseRecordId,
        expectedVersion: view.setting?.version,
      }}
      compact
      className="rounded-lg border border-line bg-surface-sunken p-3.5"
    >
      {(state) => (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            PRD 22.4: AI is off for every case until a supervisor or operations
            manager turns it on, and the decision is recorded with a reason.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="AI on this case"
              htmlFor="ai-enabled"
              error={state.fieldErrors?.enabled}
            >
              <Select
                id="ai-enabled"
                name="enabled"
                defaultValue={view.isEnabledForCase ? "on" : "off"}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </Select>
            </Field>

            <Field
              label="Reason"
              htmlFor="ai-reason"
              hint="Kept on the record, in both directions."
              error={state.fieldErrors?.reason}
            >
              <Input id="ai-reason" name="reason" defaultValue="" />
            </Field>
          </div>

          <label className="flex items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              name="clientConsent"
              defaultChecked={false}
              className="mt-0.5 size-4 rounded border-line accent-signal"
            />
            <span>
              The engagement has been checked for a contractual restriction on
              third-party processing, and there is none or consent is recorded
              (PRD 22.4).
            </span>
          </label>
        </div>
      )}
    </ActionForm>
  ) : null;

  if (!view.anyProvider) {
    return (
      <Card
        title="Assistant"
        description="PRD 22: assistive only, and currently inert."
      >
        <EmptyState
          title="No AI provider is configured"
          description="Nothing can be sent anywhere until an administrator adds a provider to the allow-list and records what its terms say about retaining and training on what it receives. The platform works fully without it."
          action={
            <AppLink
              href="/admin/ai"
              className="text-xs font-medium text-signal-dark hover:underline"
            >
              The provider allow-list
            </AppLink>
          }
        />
      </Card>
    );
  }

  if (!view.isEnabledForCase) {
    return (
      <Card
        title="Assistant"
        description="Off for this case, which is the default."
      >
        <div className="space-y-4">
          <Alert tone="info" title="AI is off for this case">
            <span className="flex items-start gap-2">
              <ShieldOff className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                PRD 22.4 keeps it off until somebody decides otherwise, because
                a free cloud provider is a third party outside PDDC&apos;s
                control.
                {view.setting && (
                  <span className="mt-1 block">
                    Last decided by {view.setting.decidedByName ?? "somebody"} on{" "}
                    {new Date(view.setting.decidedAt).toLocaleDateString()}:{" "}
                    {view.setting.reason}
                  </span>
                )}
              </span>
            </span>
          </Alert>

          {settings}
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Assistant"
      description="Answers only from this case's own records, and cites each one."
      actions={
        <Badge tone="signal">
          <Bot className="size-3" aria-hidden="true" />
          On for this case
        </Badge>
      }
    >
      <div className="space-y-4">
        <Alert tone="info">
          <span className="flex items-start gap-2">
            <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              Only PUBLIC and INTERNAL records leave the platform, with names,
              identifiers and account numbers replaced by tokens first. Evidence
              files never leave at all. Every sentence you see cites the record
              it came from; anything the model could not tie to a record is
              discarded rather than shown.
            </span>
          </span>
        </Alert>

        {view.mayAsk && (
          <ActionForm
            action={askAssistant}
            submitLabel="Ask"
            submitTone="primary"
            submitSize="sm"
            pendingLabel="Asking"
            hidden={{ caseRecordId }}
          >
            {(state) => (
              <Field
                label="Ask about this case"
                htmlFor="ai-question"
                hint="For example: what do the findings say about the purchase orders?"
                error={state.fieldErrors?.question}
              >
                <Textarea id="ai-question" name="question" rows={2} />
              </Field>
            )}
          </ActionForm>
        )}

        {view.recent.length === 0 ? (
          <EmptyState
            title="Nothing asked yet"
            description="Every question and every answer is kept on the case and in the audit trail."
          />
        ) : (
          <ul className="space-y-3">
            {view.recent.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </ul>
        )}

        {settings}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------- the allow-list */

/**
 * When a provider's breaker lifts, or null if it is not open.
 *
 * In a function rather than inline in the markup because reading the clock
 * during render is impure, and the React compiler rules are right to say so:
 * two renders of the same props would disagree. Here it is one call, read
 * once, and the component renders whatever it returned.
 */
function rateLimitedUntil(nextAttemptAt: string | null): string | null {
  if (!nextAttemptAt) return null;
  const at = new Date(nextAttemptAt);
  return at.getTime() > Date.now() ? at.toLocaleTimeString() : null;
}

function ProviderForm({
  provider,
  keyPresent,
}: {
  provider?: AiProvider;
  keyPresent?: boolean;
}) {
  return (
    <ActionForm
      action={saveAiProvider}
      submitLabel={provider ? "Save" : "Add to the allow-list"}
      submitTone={provider ? "secondary" : "primary"}
      submitSize="sm"
      pendingLabel="Saving"
      hidden={provider ? { expectedVersion: provider.version } : undefined}
    >
      {(state) => (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Key"
              htmlFor={`key-${provider?.key ?? "new"}`}
              hint="Short and stable. Used in the audit trail."
              error={state.fieldErrors?.key}
            >
              <Input
                id={`key-${provider?.key ?? "new"}`}
                name="key"
                defaultValue={provider?.key}
                readOnly={Boolean(provider)}
                placeholder="groq"
              />
            </Field>

            <Field
              label="Name"
              htmlFor={`label-${provider?.key ?? "new"}`}
              error={state.fieldErrors?.label}
            >
              <Input
                id={`label-${provider?.key ?? "new"}`}
                name="label"
                defaultValue={provider?.label}
                placeholder="Groq"
              />
            </Field>

            <Field
              label="Base URL"
              htmlFor={`url-${provider?.key ?? "new"}`}
              hint="An OpenAI-compatible endpoint, without /chat/completions."
              error={state.fieldErrors?.baseUrl}
            >
              <Input
                id={`url-${provider?.key ?? "new"}`}
                name="baseUrl"
                defaultValue={provider?.baseUrl}
                placeholder="https://api.groq.com/openai/v1"
              />
            </Field>

            <Field
              label="Model"
              htmlFor={`model-${provider?.key ?? "new"}`}
              error={state.fieldErrors?.model}
            >
              <Input
                id={`model-${provider?.key ?? "new"}`}
                name="model"
                defaultValue={provider?.model}
                placeholder="openai/gpt-oss-120b"
              />
            </Field>

            <Field
              label="API key environment variable"
              htmlFor={`env-${provider?.key ?? "new"}`}
              hint="The NAME only. The key itself is never stored here."
              error={state.fieldErrors?.apiKeyEnv}
            >
              <Input
                id={`env-${provider?.key ?? "new"}`}
                name="apiKeyEnv"
                defaultValue={provider?.apiKeyEnv}
                placeholder="GROQ_API_KEY"
              />
            </Field>

            <Field
              label="Order"
              htmlFor={`position-${provider?.key ?? "new"}`}
              hint="Lower is tried first."
              error={state.fieldErrors?.position}
            >
              <Input
                id={`position-${provider?.key ?? "new"}`}
                name="position"
                type="number"
                min={1}
                max={999}
                defaultValue={provider?.position ?? 100}
              />
            </Field>

            <Field
              label="Highest classification it may receive"
              htmlFor={`ceiling-${provider?.key ?? "new"}`}
              hint="PRD 22.4 caps everything at INTERNAL. A provider may be capped lower."
              error={state.fieldErrors?.maxClassification}
            >
              <Select
                id={`ceiling-${provider?.key ?? "new"}`}
                name="maxClassification"
                defaultValue={provider?.maxClassification ?? "INTERNAL"}
              >
                <option value="PUBLIC">PUBLIC only</option>
                <option value="INTERNAL">PUBLIC and INTERNAL</option>
              </Select>
            </Field>
          </div>

          <Field
            label="What its terms say about retention and training"
            htmlFor={`terms-${provider?.key ?? "new"}`}
            hint="Required before it can be enabled. PRD 22.4 makes reading this the condition of using a free provider, because a free tier usually carries no data-processing agreement."
            error={state.fieldErrors?.retentionTerms}
          >
            <Textarea
              id={`terms-${provider?.key ?? "new"}`}
              name="retentionTerms"
              rows={3}
              defaultValue={provider?.retentionTerms ?? ""}
            />
          </Field>

          <Field
            label="Notes"
            htmlFor={`notes-${provider?.key ?? "new"}`}
            error={state.fieldErrors?.notes}
          >
            <Input
              id={`notes-${provider?.key ?? "new"}`}
              name="notes"
              defaultValue={provider?.notes ?? ""}
            />
          </Field>

          <label className="flex items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={provider?.isEnabled ?? false}
              className="size-4 rounded border-line accent-signal"
            />
            Enabled
          </label>

          {provider && keyPresent === false && provider.isEnabled && (
            <Alert tone="warn">
              {provider.apiKeyEnv} is not set in this environment, so every
              request to {provider.label} will fail before it is sent.
            </Alert>
          )}
        </div>
      )}
    </ActionForm>
  );
}

export function AiProviders({
  providers,
  keysPresent,
  mayConfigure,
}: {
  providers: AiProvider[];
  keysPresent: Record<string, boolean>;
  mayConfigure: boolean;
}) {
  return (
    <div className="space-y-5">
      <Alert tone="info" title="What this list does">
        It is the only thing that lets a prompt leave PDDC. With it empty,
        nothing is sent anywhere and the platform works exactly as it does now;
        PRD 22&apos;s Amendment 12 makes AI assistive rather than a dependency.
        A provider also has to be turned on per case by a supervisor before
        anything about that case is sent.
      </Alert>

      {providers.length === 0 ? (
        <EmptyState
          title="No provider configured"
          description="This is the default, and it is a safe one: the assistant is inert until somebody adds a provider and records what its terms say."
        />
      ) : (
        <ul className="space-y-3">
          {providers.map((provider) => (
            <li key={provider.key}>
              <Card
                title={provider.label}
                description={`${provider.model} - tried at position ${provider.position}`}
                actions={
                  <span className="flex items-center gap-2">
                    <Badge tone={provider.isEnabled ? "ok" : "neutral"}>
                      {provider.isEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                    {keysPresent[provider.key] === false && (
                      <Badge tone="warn">Key not set</Badge>
                    )}
                    {rateLimitedUntil(provider.nextAttemptAt) && (
                      <Badge tone="warn">
                        Rate limited until {rateLimitedUntil(provider.nextAttemptAt)}
                      </Badge>
                    )}
                  </span>
                }
              >
                <div className="space-y-3">
                  <dl className="grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-faint">Endpoint</dt>
                      <dd className="text-body">
                        <Id>{provider.baseUrl}</Id>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Key read from</dt>
                      <dd className="text-body">
                        <Id>{provider.apiKeyEnv}</Id>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">May receive</dt>
                      <dd className="text-body">
                        up to {provider.maxClassification}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-faint">Terms read</dt>
                      <dd className="text-body">
                        {provider.termsReviewedAt
                          ? `${new Date(provider.termsReviewedAt).toLocaleDateString()} by ${
                              provider.termsReviewedByName ?? "somebody"
                            }`
                          : "not recorded"}
                      </dd>
                    </div>
                  </dl>

                  {provider.retentionTerms && (
                    <p className="rounded-md bg-surface-sunken p-2.5 text-[11px] leading-relaxed text-muted">
                      {provider.retentionTerms}
                    </p>
                  )}

                  {provider.lastError && (
                    <p className="text-[11px] text-danger">
                      Last failure: {provider.lastError}
                    </p>
                  )}

                  {mayConfigure && (
                    <details className="group">
                      <summary className="cursor-pointer text-xs font-medium text-signal-dark">
                        Edit
                      </summary>
                      <div className="mt-3 space-y-3">
                        <ProviderForm
                          provider={provider}
                          keyPresent={keysPresent[provider.key]}
                        />
                        <ActionForm
                          action={removeAiProvider}
                          submitLabel="Remove from the allow-list"
                          submitTone="danger"
                          submitSize="sm"
                          pendingLabel="Removing"
                          hidden={{ key: provider.key }}
                          confirm={`Remove ${provider.label}? Nothing further will be sent to it.`}
                          compact
                        />
                      </div>
                    </details>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {mayConfigure && (
        <Card
          title="Add a provider"
          description="Anything that speaks OpenAI's chat-completions shape, including a PDDC-controlled model later."
        >
          <ProviderForm />
        </Card>
      )}
    </div>
  );
}
