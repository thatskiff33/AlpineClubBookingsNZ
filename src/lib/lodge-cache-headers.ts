/**
 * Nothing the lodge kiosk asks for may be held in a cache (#3228, following
 * #176).
 *
 * ## Why this exists
 *
 * The **Lock** control's guarantee is: end the session on the server, then
 * re-ask the same URLs and get an ordinary lodge answer. That rests entirely on
 * the re-ask reaching the server. A cached hut-leader payload served to the
 * refetch would leave the privileged answers on a shared wall screen with
 * nothing left to correct it — the page has already thrown away what it held,
 * so it has nothing to compare against and no reason to ask again for two
 * minutes.
 *
 * These routes also carry guest names, phone numbers under the opt-in gate, a
 * hut leader's assignment window and, on `pin-login` and `pin-session`, a
 * `Set-Cookie` that grants privilege. None of it may sit in a browser or
 * intermediary cache on a device several people use.
 *
 * Before this, `grep -rn "Cache-Control" src/app/api/lodge/` returned nothing at
 * all, and the guarantee rested on whatever Next happened to send. The
 * precedent runs the other way: `/api/display/state` sets `no-store` explicitly
 * on every path and `docs/SECURITY-ATTACK-SURFACE.md` records why (#176).
 *
 * ## Why per route rather than one rule in `next.config.ts`
 *
 * A `headers()` rule matching `/api/lodge/:path*` looked much tidier and was
 * rejected on a security constraint this repository has already paid for. That
 * prefix is **module-gated** (`src/config/feature-routes.ts`), and
 * `src/app/__tests__/unmatched-url-status.test.ts` holds an explicit invariant:
 * a caller must not be able to tell a route that does not exist from one a
 * disabled module is hiding, or one anonymous request reads off which optional
 * modules a club runs. With the module ON an unmatched `/api/lodge/zzz` is
 * answered by an app route handler; with it OFF it is answered from middleware.
 * Whether a config-level header reaches both alike depends on where Next applies
 * config headers relative to middleware — the same question #2405 had to
 * MEASURE, and getting it wrong adds a header to one and not the other, which is
 * exactly the oracle that invariant forbids.
 *
 * A header set on a response a route handler itself produces cannot reach an
 * unmatched path at all, so the question does not arise. It is also directly
 * assertable in a route's own unit test, which a config rule is not.
 *
 * ## How to use it
 *
 * Wrap the handler's OWN return, not each `NextResponse.json(...)` inside it:
 *
 * ```ts
 * export async function GET(req: NextRequest) {
 *   return noStoreLodgeResponse(await handleGet(req));
 * }
 * ```
 *
 * One place per handler, which no later `return` can slip past — the
 * alternative was thirty-odd call sites and a reviewer checking that none was
 * missed. `export async function GET(` is kept verbatim because
 * `api-route-boundaries.test.ts` finds handlers by exactly that shape, and an
 * `export const GET = wrap(...)` would take these routes out of that census.
 *
 * ## Writes
 *
 * The `PUT` on `/api/lodge/roster/[date]` is deliberately NOT wrapped, and it is
 * the only handler on these routes that is not. Heuristic caching applies to
 * `GET` and `HEAD`: nothing stores a `PUT` response without being told to, and
 * nothing re-asks this one — the kiosk refetches the `GET` after every chore
 * toggle, and that `GET` is wrapped. Wrapping it as well would also have taken
 * that file past its 250-line route-handler budget, which an allowance cannot
 * lift for a file that was inside it to begin with; a cosmetic wrapper is not
 * worth splitting a route over.
 */

export const NO_STORE_HEADER_NAME = "Cache-Control";
export const NO_STORE_HEADER_VALUE = "no-store";

/** The response, with caching refused. Mutates and returns the same response. */
export function noStoreLodgeResponse<T extends Response>(response: T): T {
  response.headers.set(NO_STORE_HEADER_NAME, NO_STORE_HEADER_VALUE);
  return response;
}
