import { NextResponse } from "next/server";
import { hasAdminAccess } from "@/lib/access-roles";
import {
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";

export type RequireAdminMockOptions = {
  permission?: AdminAccessRequirement | false | "any-admin";
};

/**
 * Drop-in `requireAdmin` implementation for tests that mock
 * "@/lib/session-guards". Mirrors the real guard's 401/403 semantics but
 * delegates to the test's mocked `auth()` and `requireActiveSessionUser()`
 * so per-test session and active-member setups keep working.
 *
 * ## Wire it in like this — the direct reference, with no wrapper
 *
 *   vi.mock("@/lib/session-guards", async () => ({
 *     requireAdmin: (await import("./helpers/require-admin-mock"))
 *       .evaluateRequireAdminMock,
 *     requireActiveSessionUser: mocks.requireActiveSessionUser,
 *   }));
 *
 * Note the `async` factory and the **bare function reference**. Do not wrap it
 * in an arrow that re-invokes it — see the hazard below. If a file genuinely
 * needs a wrapper (a `vi.fn()` spy whose implementation is set later), the
 * wrapper MUST forward its own first parameter:
 *
 *   mockRequireAdmin.mockImplementation(async (options) =>
 *     (await import("./helpers/require-admin-mock"))
 *       .evaluateRequireAdminMock(options),
 *   );
 *
 * ## The hazard this helper has already caused (#2921)
 *
 * The route under test tells the guard which area and level it wants, by
 * passing `{ permission: { area, level } }`. This mock can only honour that if
 * the value reaches it. A wrapper that takes no parameter —
 *
 *   requireAdmin: async () => (await import(...)).evaluateRequireAdminMock(),
 *
 * — silently throws that away. With no requirement the branch below falls back
 * to `hasAdminPortalAccess`, i.e. "is this person in the admin portal at all",
 * a check the REAL guard has never performed. Every per-area assertion in such
 * a file is then vacuous: a `lodge:view`-gated route and a `lodge:edit`-gated
 * one are indistinguishable, and a test asserting that an edit-level action is
 * refused to a view-only role passes without ever exercising the rule.
 *
 * That was not theoretical. It was found in `admin-lodges-route.test.ts` when
 * the defect the new tests targeted was planted back and they stayed green, and
 * the sweep that followed found the same hole in 50 more files.
 *
 * Two controls now stop it coming back, and both are deliberate:
 *
 * 1. **`options` is a required parameter** (it accepts `undefined`, because a
 *    route that passes nothing is legitimate — but you must pass *something*).
 *    So `evaluateRequireAdminMock()` is a compile error, not a silent
 *    downgrade, and `npm run typecheck` fails the build on it.
 * 2. **`require-admin-mock-forwarding-contract.test.ts`** parses every test
 *    file that mentions this helper and fails when a call does not forward its
 *    enclosing function's own first parameter — which is the shape the type
 *    system cannot see (`evaluateRequireAdminMock({})` compiles fine and is
 *    just as inert).
 *
 * ## `permission: false` is FULL ADMIN, and this mock used to disagree (#2975)
 *
 * The real guard resolves `{ permission: false }` to `hasAdminAccess` — the
 * literal `ADMIN` role — and its own docblock spells that out: "admit ONLY a
 * full administrator, not merely somebody admitted to the portal". This mock
 * used to fold `false` into the same branch as the absent-options case and
 * answer `hasAdminPortalAccess`, so a Full-Admin-only route (the club timezone
 * write, the environment-safety override) would have been admitted here for
 * every scoped officer in the club. It is fixed below.
 *
 * No route test was relying on the old behaviour — the two routes that pass
 * `permission: false` both refuse to mock this module at all and drive the real
 * guard — so this closes a trap rather than changing a result. But it was a
 * trap of exactly the kind this helper's own docblock is about: a mock that is
 * WIDER than the guard makes the assertion "only a full admin may do this" pass
 * without ever being true.
 *
 * ## What is still an approximation, stated rather than hidden
 *
 * The absent-options case is NOT the real guard's behaviour either. The real
 * `requireAdmin()` with no options infers a requirement from the `x-pathname` /
 * `x-request-method` headers `proxy.ts` stamps, and falls back to
 * `hasAdminAccess` when they are missing; this mock has no request to read and
 * answers `hasAdminPortalAccess`, which is wider than both. It is left that way
 * deliberately: sixty-odd suites use this helper to reach routes whose real
 * gate is path-inferred, and narrowing it here would turn a fidelity fix into a
 * mass rewrite of unrelated files.
 *
 * The consequence is worth being precise about, because it bounds what those
 * suites prove: **through this mock, a bare-`requireAdmin()` route cannot
 * demonstrate its own area or level.** That proof lives in
 * `admin-route-authorization-proof.test.ts` (#2975), which drives the REAL
 * guard, over the REAL path-to-permission map, for every admin page and
 * `/api/admin` route discovered on disk. Assert domain behaviour here; do not
 * assert authorization here.
 */
export async function evaluateRequireAdminMock(
  options: RequireAdminMockOptions | undefined,
) {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const permission = options?.permission;
  const requirement =
    permission === false || permission === "any-admin"
      ? null
      : (permission ?? null);
  const hasAccess = requirement
    ? hasAdminAreaAccess(session.user, requirement)
    : // `false` means Full Admin ONLY in the real guard (#2975). "any-admin"
      // and the absent-options case both answer hasAdminPortalAccess: exact for
      // the first (#2925), a documented widening for the second.
      permission === false
      ? hasAdminAccess(session.user)
      : hasAdminPortalAccess(session.user);
  if (!hasAccess) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  const { requireActiveSessionUser } = await import("@/lib/session-guards");
  const inactive = await requireActiveSessionUser(session.user.id);
  if (inactive) {
    return { ok: false as const, response: inactive };
  }
  return { ok: true as const, session };
}
