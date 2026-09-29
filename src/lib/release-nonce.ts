/**
 * The ONE CSP script nonce every `(website)` page carries for the life of a
 * release (#2352, owner decision D1, 31 Jul 2026).
 *
 * ## Why a fixed nonce exists at all
 *
 * A stored page can only carry one nonce value. Next stamps the nonce into its
 * own inline bootstrap/RSC scripts at RENDER time, reading it from the request's
 * own `Content-Security-Policy` header
 * (`next/dist/server/app-render/app-render.js`). So the moment a public page is
 * served from the full-route ISR cache rather than re-rendered, the value frozen
 * into that stored HTML has to keep matching the policy on every later response,
 * or every inline script on the page is blocked and the page never hydrates.
 *
 * The two alternatives were measured and are not available (see the #2352
 * planning comment): the proxy cannot inject a nonce into a response BODY, and a
 * build-time hash list cannot cover Next's RSC payload scripts, whose contents
 * literally contain the rendered page and therefore change on every admin edit.
 *
 * ## What the trade actually costs
 *
 * The value is readable in the page source, so on those pages it no longer stops
 * a fully injected `<script>` tag. It still stops the commoner injection shapes
 * (`onclick=` handlers, `javascript:` URLs), and every other directive is
 * unchanged — `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`,
 * `frame-ancestors 'none'`, and no `unsafe-inline`. The only untrusted content on
 * these pages is admin-authored CMS HTML, allowlist-sanitised on write AND again
 * on read with no `script` and no `on*` attributes permitted. Recorded in full in
 * `docs/SECURITY-ATTACK-SURFACE.md`.
 *
 * Login, the member area, admin, finance, lodge and `/display` keep a fresh
 * per-request nonce, unchanged. `src/lib/csp.ts` owns that split.
 *
 * ## Why it is derived from a RELEASE identifier and not minted at boot
 *
 * The page cache is a per-container tmpfs (`docker-compose.yml`) wiped on
 * restart, so a stored page never outlives its own container. But a container can
 * have more than one reader — blue/green runs two, and a fork may run replicas —
 * and a per-process value would then differ between the process that STORED a
 * page and a process that SERVES it. Deriving from a value baked into the IMAGE
 * makes every reader of one release agree by construction, with no coordination.
 *
 * `RELEASE_ID` is a build ARG (`Dockerfile`), promoted to an ENV in BOTH the
 * builder and the runner stage on purpose: the builder ENV is what a bundle that
 * inlines `process.env` at build time would capture, the runner ENV is what a
 * runtime read sees, and setting both from the same ARG means the two can never
 * disagree. `GIT_COMMIT_SHA` is now declared in the runner as well, so the second
 * fallback below is actually reachable at runtime.
 *
 * The runner stage PRINTS which state the image is in; it does not fail, because a
 * bare `docker build` and a plain `docker compose build` both legitimately have no
 * release. What fails is CI: `publish-ghcr-images` runs the IMAGE IT JUST PUSHED
 * and asserts `RELEASE_ID` equals the built commit. That assertion used to be on a
 * throwaway scan image while the published one was built without the argument at
 * all (slice-1 review finding).
 *
 * ## The nonce is a DIGEST, not the identifier
 *
 * CI and the deploy runner both pass the commit SHA as `RELEASE_ID`. That value
 * is not secret, but it is not something a public page needs to publish either,
 * so the nonce is a SHA-256 of a namespaced string rather than the id itself.
 * Nothing about the deployed revision is recoverable from the page source.
 *
 * ## This module exists TWICE in one process, and the fallback has to survive that
 *
 * `src/proxy.ts` imports it from the proxy/middleware entry and
 * `(website)/layout.tsx` imports it from the app-server graph. Next compiles those
 * separately, so `resolution` below is memoised per BUNDLE, not per process —
 * there are two memos and they never see each other. With a release identifier
 * that is harmless: both digest the same string and get the same nonce.
 *
 * It was NOT harmless on the old fallback, which minted `createCspNonce()`
 * independently in each bundle. The proxy then published one nonce in the policy
 * while the layout stamped a different one onto the analytics `<Script nonce>`, so
 * on any build with no release identifier — `pnpm run dev`, a bare `docker build` —
 * Google Analytics was refused on every public page with the analytics module on.
 * The previous docblock's "keeps a single-process deployment self-consistent" was
 * wrong for exactly this reason, and DEPLOYMENT.md repeated it.
 *
 * ## Fallback, stated rather than hidden
 *
 * So the fallback is a BUILD-TIME SEED (`src/lib/release-nonce-seed.ts`), produced
 * once in `next.config.ts` and substituted into every bundle by Next's
 * DefinePlugin. Both copies of this module therefore read the same literal and
 * agree by construction, with nothing to configure. It is random per build rather
 * than a constant, because a constant would publish the nonce and that is
 * `unsafe-inline` in all but name.
 *
 * The per-process random remains as the LAST resort, for the case where even the
 * seed was not substituted (a bundler or config change that dropped `env`). It is
 * logged at error level and it is NOT safe: the two bundles disagree, which is the
 * failure described above. `source` is exposed so tests and diagnostics can tell
 * the four cases apart.
 */

import { createCspNonce } from "@/lib/csp";
import logger from "@/lib/logger";
import { PUBLIC_WEBSITE_NONCE_SEED_ENV_VAR } from "@/lib/release-nonce-seed";

/**
 * The build ARG / ENV carrying the release identifier. Exported for the docs and
 * the tests; the reads below use the literal `process.env.RELEASE_ID` form
 * because a computed key is not statically replaceable by a bundler.
 */
export const RELEASE_ID_ENV_VAR = "RELEASE_ID";

/**
 * Namespaces the digest so the same release identifier can never produce the
 * same value for two different purposes, and so a future change of scheme is a
 * version bump here rather than a silent reuse.
 */
const RELEASE_NONCE_DOMAIN = "alpine-club-bookings:public-website-csp-nonce:v1";

export type PublicWebsiteNonceSource =
  /** `RELEASE_ID`, the intended production path. */
  | "release-id"
  /** `GIT_COMMIT_SHA`, already wired for the AID-3 knowledge bundle (#2372). */
  | "commit-sha"
  /**
   * The build-time seed `next.config.ts` substitutes into every bundle. Safe —
   * one value per build, shared by the proxy and the app graph — but it means no
   * release identifier reached the image, so the deploy path is worth checking.
   */
  | "build-seed"
  /**
   * Not even the seed was readable: one random value per MODULE INSTANCE, and
   * there are two of them. See the docblock — this is a broken state, not a
   * degraded one.
   */
  | "process-fallback";

export interface PublicWebsiteNonce {
  /** The `'nonce-…'` value used on every `(website)` response of this release. */
  nonce: string;
  source: PublicWebsiteNonceSource;
}

let resolution: Promise<PublicWebsiteNonce> | null = null;

/** The release identifier this image was built with, or null. */
function readReleaseId(): {
  releaseId: string;
  source: Exclude<PublicWebsiteNonceSource, "process-fallback">;
} | null {
  const releaseId = process.env.RELEASE_ID?.trim();
  if (releaseId) {
    return { releaseId, source: "release-id" };
  }

  // Already passed by CI and by scripts/run-production-blue-green-deploy.sh for
  // the knowledge bundle, so an image built before RELEASE_ID existed — or a
  // fork that only wired the older arg — still gets a per-release value rather
  // than the per-process fallback. Promoted into the Dockerfile's RUNNER stage in
  // the slice-1 review so a runtime read can actually see it.
  const commitSha = process.env.GIT_COMMIT_SHA?.trim();
  if (commitSha) {
    return { releaseId: commitSha, source: "commit-sha" };
  }

  // The build-time seed. Written as the literal `process.env.<NAME>` form on
  // purpose — a computed key is not statically replaceable, and static
  // replacement into both bundles is the entire mechanism.
  const buildSeed = process.env.PUBLIC_WEBSITE_NONCE_SEED?.trim();
  if (buildSeed) {
    return { releaseId: buildSeed, source: "build-seed" };
  }

  return null;
}

/**
 * `crypto.subtle` rather than `node:crypto`, because this module is imported by
 * `src/proxy.ts` as well as by a server component, and WebCrypto is the only
 * digest available on every middleware runtime. Async for the same reason —
 * both call sites are already async, so it costs nothing.
 */
async function digestToNonce(releaseId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${RELEASE_NONCE_DOMAIN}:${releaseId}`),
  );

  return Buffer.from(digest).toString("base64");
}

async function resolve(): Promise<PublicWebsiteNonce> {
  const release = readReleaseId();

  if (!release) {
    logger.error(
      {
        releaseIdEnvVar: RELEASE_ID_ENV_VAR,
        seedEnvVar: PUBLIC_WEBSITE_NONCE_SEED_ENV_VAR,
      },
      "No release identifier and no build-time nonce seed are readable, so this " +
        "bundle will mint its own CSP nonce. The proxy and the website layout are " +
        "separate bundles, so they will disagree and the analytics scripts on " +
        "public pages will be refused — check that next.config.ts still sets `env`, " +
        "and set RELEASE_ID at image build.",
    );
    return { nonce: createCspNonce(), source: "process-fallback" };
  }

  return {
    nonce: await digestToNonce(release.releaseId),
    source: release.source,
  };
}

/**
 * The fixed nonce and where it came from. Memoised on the resolved PROMISE, so
 * concurrent first callers share one digest rather than racing to compute it.
 */
export function resolvePublicWebsiteNonce(): Promise<PublicWebsiteNonce> {
  resolution ??= resolve();
  return resolution;
}

/** The fixed nonce for every `(website)` page of this release. */
export async function getPublicWebsiteNonce(): Promise<string> {
  return (await resolvePublicWebsiteNonce()).nonce;
}

// test seam
export function resetPublicWebsiteNonceCache(): void {
  resolution = null;
}
