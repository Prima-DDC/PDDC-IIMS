import "server-only";
import { can, canAll, requireActor } from "@/lib/auth/session";
import { ai } from "@/modules/ai";

/** Read models for the assistant panel and the provider screen (PRD 22). */

/**
 * Everything the case assistant panel needs to decide what to render.
 *
 * The four states it has to be able to show are all honest refusals rather
 * than errors, and PRD 22's "the platform works fully with it switched off"
 * is why: no provider configured, the case not opted in, no permission, and
 * available. A panel that only knew how to work would show a spinner for
 * three of those.
 */
export async function getCaseAssistant(caseRecordId: string) {
  const actor = await requireActor();
  const api = ai(actor);

  const [allowed, providers, setting, jobs] = await Promise.all([
    canAll(actor, [
      { resource: "ai", action: "view" },
      { resource: "ai", action: "create" },
      { resource: "ai", action: "approve" },
    ]),
    api.providers.list(),
    api.caseSettings.forCase(caseRecordId),
    api.jobs.list({ caseId: caseRecordId, limit: 10 }),
  ]);

  const enabledProviders = providers.filter((provider) => provider.isEnabled);

  return {
    mayView: allowed["ai:view"],
    mayAsk: allowed["ai:create"],
    mayDecideForCase: allowed["ai:approve"],
    /** The allow-list is empty or everything in it is off (PRD 22.4). */
    anyProvider: enabledProviders.length > 0,
    providerCount: enabledProviders.length,
    setting,
    isEnabledForCase: setting?.isEnabled === true,
    recent: jobs.rows,
    total: jobs.total,
  };
}

export async function getAiProviders() {
  const actor = await requireActor();
  const [providers, mayConfigure] = await Promise.all([
    ai(actor).providers.list(),
    can(actor, "ai", "configure"),
  ]);

  return {
    providers,
    mayConfigure,
    /**
     * Which environment variables are actually set.
     *
     * Presence only, never any part of a value. A provider enabled with its
     * key absent would fail on every request with a message nobody could act
     * on from the screen, so the screen says so instead.
     */
    keysPresent: Object.fromEntries(
      providers.map((provider) => [
        provider.key,
        Boolean(process.env[provider.apiKeyEnv]),
      ]),
    ),
  };
}

export async function getAiJob(id: string) {
  const actor = await requireActor();
  return ai(actor).jobs.find(id);
}
