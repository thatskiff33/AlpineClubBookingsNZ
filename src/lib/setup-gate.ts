import { NextResponse, type NextRequest } from "next/server";
import { clubConfig } from "@/config/club";
import { getClubIdentity } from "@/lib/club-identity-settings";
import {
  getWebsiteThemeRenderState,
  readSetupCompletion,
} from "@/lib/club-theme";
import { loadEmailMessageSettings } from "@/lib/email-message-settings";
import { isPublicWebsitePath } from "@/lib/public-website-paths";
import {
  buildSetupInProgressDocument,
  SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS,
} from "@/lib/setup-in-progress-screen";

/**
 * "Not ready yet" for the whole public website until setup is complete (#2420).
 *
 * ## Why the decision lives in the proxy and not in a layout
 *
 * While `ClubTheme.completedAt IS NULL`, the shared public chrome
 * (`src/components/website/website-chrome.tsx`) returns its
 * holding screen INSTEAD of `{children}`, so the page component never runs, its
 * `notFound()` never fires, and every address — real page and typo alike —
 * answers `200 OK`. A layout has no way to set a status code: `notFound()` is
 * the only status a render can raise and it means something else. So the
 * decision has to be made before the render starts, and the proxy is the only
 * place in this app that runs before every request and can write a status.
 *
 * ## The two choices this gate makes, stated rather than left to fall out
 *
 * - **A real, published page is 503 too, not 200.** While setup is incomplete
 *   the site is not open, so "this page exists" is not a distinction worth
 *   drawing for a visitor. Answering 200 for `/about` and 503 for `/nope` would
 *   also publish the club's page inventory to anyone probing a half-built
 *   install, and would let a crawler index pages before the club has chosen how
 *   they look. Every gated address gets the same screen and the same status.
 * - **`Retry-After` is sent.** Rationale and the value live with the constant in
 *   `setup-in-progress-screen.ts`.
 *
 * ## Interaction with #2352 (static / ISR rendering of website pages)
 *
 * This gate is deliberately NOT a render-time check, so making `(website)`
 * routes static or incrementally cached cannot bypass it: the proxy runs on the
 * request even when the response would have been served from a prerender. What
 * #2352 does need to handle is the reverse direction — a page prerendered while
 * setup was incomplete must be revalidated when setup completes, or the first
 * post-setup visitor gets a cache entry built under the holding screen.
 */

/**
 * The path classifier now lives in `src/lib/public-website-paths.ts` and is
 * RE-EXPORTED here, unchanged, so every existing importer and the filesystem
 * exhaustiveness check in `setup-gate.test.ts` keep working.
 *
 * It moved in the #2352 slice-1 review because other callers need it and must not
 * pay for this module's database reads. Since the D1 narrowing (owner decision,
 * 3 Aug 2026) those callers use a DIFFERENT predicate from the same module: the
 * nonce split and the CMS catch-all's territory are `isFixedNonceWebsitePath()`
 * and `isCmsServablePageSlug()`, which cover only the five approved routes, while
 * `isPublicWebsitePath()` — the one this gate asks — deliberately still claims the
 * whole public website, both route groups. That is what keeps the pre-setup 503
 * holding screen in front of `/hut-leader-instructions`, `/join/[code]` and
 * `/join/verify/[token]` after they moved out of the fixed-nonce group. The
 * module's header sets out all three questions and which predicate answers each.
 */
export {
  isPublicWebsitePath,
  NON_WEBSITE_ROOT_SEGMENTS,
} from "@/lib/public-website-paths";

type SetupGateState =
  | { isComplete: true }
  | { isComplete: false; document: string };

/**
 * How long the resolved setup state (and, while incomplete, the rendered
 * holding-screen document) is treated as fresh.
 *
 * The point of caching is the constraint that this gate must not add a database
 * read to every request. Matching the shared public chrome's 15-second theme
 * cache (`getCachedWebsiteThemeRenderState`) means the gate costs at most one
 * extra single-column read per 15 seconds per process, not one per request.
 * Once setup IS complete, that read is `completedAt` alone
 * (`readSetupCompletion`); the theme and the holding screen are only loaded
 * while setup is incomplete.
 *
 * The proxy is bundled separately from the app's route handlers, so the
 * `revalidateTag` the site-style save already issues cannot reach this memo —
 * the TTL is the propagation bound. An expired answer is still served while one
 * background refresh runs (see `getSetupGateState`), so an operator who
 * finishes setup sees the site open on the second request after the 15 seconds
 * are up: the first starts the refresh, a later one gets its answer.
 */
export const SETUP_STATE_TTL_MS = 15_000;

/**
 * How long one refresh may take before it counts as a thrown read. Prisma has
 * no query timeout, so a query on a half-open connection (after a database
 * failover, say) can hang indefinitely; without this bound the single-flight
 * promise would never clear and the stale answer would be served forever with
 * no retry. The hung query is abandoned, not cancelled; its late result is
 * ignored.
 */
export const SETUP_STATE_READ_TIMEOUT_MS = 5_000;

let cachedState: { expiresAt: number; state: SetupGateState } | null = null;
let inFlight: Promise<SetupGateState> | null = null;

function withReadTimeout<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("setup-gate read timed out")),
      SETUP_STATE_READ_TIMEOUT_MS,
    );
  });
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Last-resort holding screen, for the case where even resolving the setup state
 * throws — a Prisma client that failed to construct at all, say, which is a
 * realistic first-boot state for the very install this screen exists to cover.
 * Config-derived only, so it needs nothing but the club file. Answering 503 with
 * a readable screen beats the 500 an unhandled throw in the proxy would produce.
 */
function fallbackSetupGateState(): SetupGateState {
  return {
    isComplete: false,
    document: buildSetupInProgressDocument({
      clubName: clubConfig.name,
      contactEmail: clubConfig.contactEmail ?? clubConfig.supportEmail,
      themeCss: "",
    }),
  };
}

/**
 * One read of the setup state. `readFailed` is true only when the database did
 * not answer: the state is then the holding screen, which is right for a cold
 * start but must not replace a known "complete" (see `refreshSetupGateState`).
 */
async function loadSetupGateState(): Promise<{
  state: SetupGateState;
  readFailed: boolean;
}> {
  const completion = await readSetupCompletion();

  if (!completion.readFailed && completion.isComplete) {
    return { state: { isComplete: true }, readFailed: false };
  }

  if (completion.readFailed) {
    return loadHoldingScreen(completion);
  }

  // The database positively said "not complete". That is a real answer, so a
  // throw while building the screen must not fall into the refresh's rejection
  // arm, which would keep a stale "complete": close with the config screen.
  try {
    return await loadHoldingScreen(completion);
  } catch {
    return { state: fallbackSetupGateState(), readFailed: false };
  }
}

async function loadHoldingScreen(
  completion: Awaited<ReturnType<typeof readSetupCompletion>>,
): Promise<{ state: SetupGateState; readFailed: boolean }> {
  const theme = await getWebsiteThemeRenderState();

  // Setup finished between the two reads.
  if (theme.isComplete) {
    return { state: { isComplete: true }, readFailed: false };
  }

  // Only read once the site is known to be unconfigured, and read from exactly
  // the sources the shared public chrome's own pre-setup branch reads, so the two
  // screens can never name the club or the contact address differently. Neither
  // call throws — both fall back to config defaults if the database is
  // unreachable — which matters because this path has to be able to render a
  // 503 body during precisely the outage that produced it.
  const [identity, emailSettings] = await Promise.all([
    getClubIdentity(),
    loadEmailMessageSettings(),
  ]);

  return {
    state: {
      isComplete: false,
      document: buildSetupInProgressDocument({
        clubName: identity.name,
        contactEmail: emailSettings.contactEmail,
        themeCss: theme.css,
      }),
    },
    // Failed only if neither read answered: a positive "not complete" from
    // either is a real answer, even if the other read did not get through.
    readFailed: completion.readFailed && theme.readFailed,
  };
}

/**
 * Reads the state and memoises it, keeping the previous answer when the read
 * fails. A thrown load keeps whatever was there, or falls back to the
 * config-derived screen on a cold start. A database that did not answer keeps a
 * known "complete": closing a live club's website because of a blip would be
 * the same launch-state lie `getWebsiteThemeRenderState()`'s `readFailed`
 * exists to prevent. Either way the result is stamped fresh, so a failing
 * database is retried once per TTL rather than on every request.
 *
 * A read that neither answers nor fails within
 * {@link SETUP_STATE_READ_TIMEOUT_MS} counts as thrown (see `withReadTimeout`).
 */
function refreshSetupGateState(): Promise<SetupGateState> {
  inFlight ??= withReadTimeout(loadSetupGateState())
    .then(
      ({ state, readFailed }) =>
        readFailed && cachedState?.state.isComplete ? cachedState.state : state,
      () => cachedState?.state ?? fallbackSetupGateState(),
    )
    .then((state) => {
      cachedState = { expiresAt: Date.now() + SETUP_STATE_TTL_MS, state };
      return state;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * The current setup state, memoised for {@link SETUP_STATE_TTL_MS}.
 *
 * Stale while refreshing: once any answer exists it is returned at once, and an
 * expired one starts a single background refresh. Only a cold start waits for
 * the read. Before #5264 every expiry made the request that found it wait for
 * the whole theme to load and its CSS to build, which stalled a public page
 * every 15 seconds.
 *
 * Single-flight: concurrent requests share one read rather than each opening
 * their own.
 *
 * Fails CLOSED. A cold start whose read fails, or throws, answers with the
 * holding screen, which is both what the layout does and what 503 literally
 * means. Failing open would put the site back to answering 200 for every
 * address, which is the defect this gate exists to fix.
 */
export async function getSetupGateState(): Promise<SetupGateState> {
  if (!cachedState) {
    return refreshSetupGateState();
  }

  if (cachedState.expiresAt <= Date.now()) {
    // The refresh handles its own failures; the catch is insurance against an
    // unhandled rejection taking the process down.
    refreshSetupGateState().catch(() => {});
  }

  return cachedState.state;
}

// test seam
export function resetSetupGateCache() {
  cachedState = null;
  inFlight = null;
}

/**
 * The 503 holding-screen response for a gated request, or `null` to let the
 * request continue.
 *
 * `no-store` is not optional: the holding screen must not outlive setup in a
 * browser or shared cache, and `/` is otherwise allow-listed as cacheable for
 * 60 seconds by `getAnonymousPageCacheControl`.
 */
export async function getSetupInProgressResponse(
  request: NextRequest,
): Promise<NextResponse | null> {
  if (!isPublicWebsitePath(request.nextUrl.pathname)) {
    return null;
  }

  const state = await getSetupGateState();

  if (state.isComplete) {
    return null;
  }

  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": String(SETUP_IN_PROGRESS_RETRY_AFTER_SECONDS),
  });

  // Every method, not just GET: a form POST to a website address during setup is
  // no more serviceable than a GET of it. HEAD carries the same status with no
  // body, per HTTP.
  return new NextResponse(request.method === "HEAD" ? null : state.document, {
    status: 503,
    headers,
  });
}
