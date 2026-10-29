import NextLink from "next/link";
import type { ComponentProps } from "react";

/**
 * A link that does not prefetch unless it is asked to.
 *
 * WHY THIS EXISTS
 * Next prefetches every `<Link>` that comes into view. For a marketing site
 * that is free performance. For this platform it was the single largest
 * source of load, and the cause of a failure that looked like nothing else.
 *
 * Measured against the live project, opening one case page made the browser
 * request:
 *
 *   every destination in the sidebar, fourteen of them, each a
 *   permission-filtered register backed by several database reads;
 *   the case page itself nine more times, once per tab, because the tab bar
 *   is nine links to the same route with a different query string;
 *   and one detail page per row of every table on screen.
 *
 * Each of those is a full server render opening transactions against a
 * database 130ms away, through a pooler that serves this project from a small
 * server pool. The consequence was not slowness. Submitting a form took the
 * request list from one POST to several dozen GETs; the write landed, the
 * action answered 200 with a complete body, and the screen never showed it,
 * because the client was still waiting behind renders nobody had asked for.
 * The button sat on "Saving" with no error anywhere. It got worse with every
 * milestone, because every milestone adds another register to the sidebar and
 * another tab to the case file.
 *
 * So prefetching is opt-in here. A link in navigation chrome, a tab bar or a
 * table row is navigated deliberately and rarely, and fetching the page when
 * somebody actually clicks it costs one render: the one they wanted. Where a
 * prefetch genuinely earns its place, pass `prefetch` explicitly and say why.
 *
 * Everything in `app/` and `features/` imports this instead of `next/link`,
 * which eslint enforces, so a page added later cannot quietly reintroduce the
 * problem.
 */
export function AppLink({
  prefetch = false,
  ...props
}: ComponentProps<typeof NextLink>) {
  return <NextLink prefetch={prefetch} {...props} />;
}
