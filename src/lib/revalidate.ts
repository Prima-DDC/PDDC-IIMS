import "server-only";

/**
 * Declares that a write has made a path stale.
 *
 * Every action in the platform says which screens its write affects, because
 * that is worth stating and worth reading. This module decides how the
 * declaration is honoured, and today it honours it by doing nothing on the
 * server and letting the client refresh instead. The reason is measured, and
 * it is worth writing down properly.
 *
 * WHAT NOTHING IS CACHED MEANS
 * This application caches no route. There is no `unstable_cache`, no
 * `"use cache"`, no `export const revalidate`, and every route in the build
 * output is dynamic: each request reads the database through row-level
 * security, which is the whole point, because two people on the same URL must
 * be able to see different things. So `revalidatePath` was never invalidating
 * a cache here. It had exactly one effect: it made Next append a fresh render
 * of the route to the server action's own response.
 *
 * WHY THAT ONE EFFECT HAD TO GO
 * Under Next 16.2.10, on a route of this size, that appended render wedges
 * roughly one action in two. Measured against the live project, registering a
 * subject from the case file: the row was always written, the response always
 * came back 200 with a complete body of 108 to 127 kilobytes, and the screen
 * showed nothing. The submit button sat on "Saving" indefinitely with no
 * error in the browser, none in the server log, and no failing query. With
 * the `revalidatePath` calls removed the same action settled in about eight
 * seconds, every time, across repeated runs. Bisected to the call itself:
 * scoping it to the page segment did not help, nor did the pool size (tried
 * at 4, 10 and 25), nor cutting the page's transaction count from nine to
 * three.
 *
 * A write that lands while the screen says it is still saving is the worst
 * failure shape a form can have: the user does not know whether to try again,
 * and trying again is how you get two of everything. So the refresh moved to
 * where it cannot take the action's reply down with it.
 *
 * WHERE THE REFRESH HAPPENS NOW
 * `ActionForm` calls `router.refresh()` once a submission has succeeded. That
 * is a separate request, so the action's own transition completes on its own
 * terms: the confirmation appears at once and the panel behind it catches up
 * a moment later, which is also the better thing to look at.
 *
 * WHEN TO PUT IT BACK
 * The call sites are unchanged, so if a later Next release fixes this, the
 * body below is the only thing to edit. Anybody doing that should re-run the
 * measurement rather than trust that it is fixed: the symptom is silent.
 */
export function refreshPath(path: string): void {
  // Deliberately does nothing. See above: there is no cache to invalidate,
  // and asking Next to re-render the route here is what breaks the reply.
  void path;
}
