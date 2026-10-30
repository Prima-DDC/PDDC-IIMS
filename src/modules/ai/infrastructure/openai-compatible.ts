import "server-only";
import { AiError } from "../domain/errors";
import type { ModelPort } from "../application/ports";

/**
 * One adapter for every provider (PRD 22.1).
 *
 * Groq, Cerebras, OpenRouter, Cloudflare Workers AI and Mistral all expose
 * OpenAI's `/chat/completions` shape, which is why the allow-list stores a
 * base URL and a model name rather than a provider type: adding a provider is
 * a row, not a class. A PDDC-controlled model later is the same row with a
 * different URL, which is PRD 22.4's "local-model path" with no feature
 * changes.
 *
 * The API key is read from the environment by the NAME the allow-list holds,
 * so no credential is ever stored in a table a backup copies, and an
 * administrator adding a provider cannot accidentally paste a key into a
 * field that gets exported.
 */

/** Long enough for a free tier under load, short enough not to hold a worker. */
const TIMEOUT_MS = 45_000;

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export function createOpenAiCompatibleModel(): ModelPort {
  return {
    async complete({ provider, sendable }) {
      const key = process.env[provider.apiKeyEnv];

      if (!key) {
        throw new AiError(
          "no_provider",
          `${provider.label} is enabled but ${provider.apiKeyEnv} is not set in this environment, so nothing can be sent to it.`,
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      let response: Response;
      try {
        response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model: provider.model,
            // Zero, because this is an evidentiary platform. A model asked
            // the same question about the same passages twice should answer
            // the same way twice, and a cache that can return a different
            // answer from the one a colleague saw is worse than no cache.
            temperature: 0,
            max_tokens: sendable.maxOutputTokens,
            messages: [
              { role: "system", content: sendable.system },
              { role: "user", content: sendable.user },
            ],
          }),
        });
      } catch (error) {
        clearTimeout(timer);
        // A timeout or a transport failure is the provider being
        // unavailable, which the router treats as "try the next one". Given
        // no status, `shouldTryNextProvider` does exactly that.
        const reason =
          (error as { name?: string }).name === "AbortError"
            ? `${provider.label} did not answer within ${TIMEOUT_MS / 1000}s`
            : error instanceof Error
              ? error.message
              : String(error);
        throw Object.assign(new Error(reason), { status: undefined });
      }
      clearTimeout(timer);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        // The status is attached so the router can tell a rate limit from a
        // malformed request, which is the difference between failing over
        // and stopping.
        throw Object.assign(
          new Error(
            `${provider.label} returned ${response.status}${
              body ? `: ${body.slice(0, 300)}` : ""
            }`,
          ),
          { status: response.status },
        );
      }

      const payload = (await response.json()) as ChatCompletion;

      if (payload.error?.message) {
        // Some providers return 200 with an error body, which would otherwise
        // read as an empty but successful answer.
        throw Object.assign(
          new Error(`${provider.label}: ${payload.error.message}`),
          { status: 502 },
        );
      }

      const text = payload.choices?.[0]?.message?.content ?? "";

      if (text.trim().length === 0) {
        throw Object.assign(
          new Error(`${provider.label} returned an empty answer`),
          { status: 502 },
        );
      }

      return {
        text,
        promptTokens: payload.usage?.prompt_tokens ?? null,
        completionTokens: payload.usage?.completion_tokens ?? null,
      };
    },
  };
}
