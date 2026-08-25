/**
 * TEST-ONLY Xero endpoint seam for the mock-Xero E2E harness (#2080).
 *
 * PRODUCTION-INERT BY CONSTRUCTION: every function here short-circuits to a
 * no-op / undefined unless `XERO_MOCK_API_ORIGIN` is set in the environment.
 * That variable is NEVER set in a real deployment — it is set only by the E2E
 * staging stack (.env.staging) and points at the app's OWN origin so the app
 * drives a set of gated mock endpoints (`/api/testing/xero-mock/*`) instead of
 * the real identity.xero.com / api.xero.com. When it is unset, the OAuth and
 * organisation code paths run exactly as before through `xero-node` — this
 * module contributes nothing.
 *
 * The mock deliberately mirrors only what steps 1–3 of the wizard exercise
 * (consent redirect, token exchange, connections, organisation). C3 extends the
 * gated route handlers with a webhook-validation ping and chart of accounts;
 * this seam does not need to change for that.
 */

import {
  saveXeroTokens,
} from "@/lib/xero-token-store";
import { readEnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";
import { getOperationalXeroRedirectUri } from "@/lib/xero-config";
import { XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE } from "@/lib/xero-oauth-callback-messages";

const MOCK_BASE_PATH = "/api/testing/xero-mock";

// Fixed fixture identity the gated mock endpoints return, shared with the
// Playwright spec so it can assert the wizard confirms the RIGHT org.
export const MOCK_XERO_TENANT_ID = "mock-tenant-0001";
export const MOCK_XERO_ORG_NAME = "Alpine Test Club Ltd";
export const MOCK_XERO_ORG_FINANCIAL_YEAR_END_MONTH = 3;
// Organisation short code (#2261): the identifier Xero deep links need. Shaped
// like a real one (`!` + alphanumerics) so the E2E harness exercises the same
// URL-encoding path as production.
export const MOCK_XERO_ORG_SHORT_CODE = "!mock1";

/**
 * True in a REAL production runtime (never the E2E staging stack). Used as a
 * hard backstop so the mock stays inert even if `XERO_MOCK_API_ORIGIN` ever
 * leaked into a genuine deployment (#2080 review, CORRECTNESS-F2).
 *
 * THE DECLARATION IS ASKED FIRST (ENV-SAFETY 3, #3036; INV-CONFIG-003). A
 * deployment that declares itself `APP_ENVIRONMENT_ROLE=production` is a real
 * production runtime, full stop — that is the canonical answer and it is read
 * through the canonical parser rather than re-derived here. This is a strict
 * WIDENING of the old rule: everything that returned true before still does.
 *
 * WHAT IS LEFT UNDERNEATH IS A BACKSTOP AND NO LONGER AN AUTHORITY, which is why
 * #3034's inference census keeps listing it and why collapsing it away was
 * REJECTED rather than deferred. `NODE_ENV` is a build mode and
 * `APP_RUNTIME_ROLE` is a container slot name, so neither can answer "is this
 * production?" — but here they are only ever used to *disable* a harness that
 * already requires an explicit `XERO_MOCK_API_ORIGIN` opt-in. Deleting them and
 * trusting the declaration alone would make an UNDECLARED installation — the
 * live club that upgraded without adding the line, which is this epic's headline
 * case — pass a gate that today's build-mode check fails. So both stay, in an OR,
 * and the guarantee only ever gets stronger.
 *
 * The E2E staging stack legitimately runs the PRODUCTION build
 * (`NODE_ENV=production`, `node server.js`) with the mock enabled, so `NODE_ENV`
 * alone could never have been the gate — it would disable the E2E happy path.
 * That stack declares `APP_ENVIRONMENT_ROLE=non-production` and sets
 * `APP_RUNTIME_ROLE=staging` (docker-compose.staging.yml), so it falls through
 * both halves and the mock stays available there.
 */
export function isRealProductionRuntime(): boolean {
  if (readEnvironmentRoleDeclaration().kind === "production") return true;
  return (
    process.env.NODE_ENV === "production" &&
    process.env.APP_RUNTIME_ROLE !== "staging"
  );
}

/**
 * The mock Xero API origin, or undefined in every real deployment. When defined,
 * the OAuth/organisation code routes through the gated mock endpoints instead of
 * the live Xero servers.
 *
 * Two independent conditions must BOTH hold: `XERO_MOCK_API_ORIGIN` is set AND
 * this is not a real production runtime. Either alone leaves the mock inert.
 */
export function getXeroMockApiOrigin(): string | undefined {
  if (isRealProductionRuntime()) return undefined;
  const raw = process.env.XERO_MOCK_API_ORIGIN?.trim();
  return raw ? raw : undefined;
}

/** True when the mock harness is active (test env only). */
export function isXeroMockActive(): boolean {
  return getXeroMockApiOrigin() !== undefined;
}

/**
 * The origin SERVER-SIDE mock consumers (token exchange, organisation fetch)
 * should call, or undefined whenever the mock is inactive.
 *
 * `XERO_MOCK_API_ORIGIN` is the BROWSER-facing origin (the consent URL the
 * operator's browser navigates to). In the CI E2E stack the app is exposed on
 * the host as :3001 but listens in-container on :3000, so a server-side fetch
 * of the browser origin would dial a port nothing listens on inside the
 * container. `XERO_MOCK_INTERNAL_ORIGIN` carries the in-container self-origin
 * for those calls; it defaults to the browser origin so single-port local
 * setups need only one variable. Gated identically — inert unless the mock as
 * a whole is active.
 */
export function getXeroMockInternalOrigin(): string | undefined {
  const publicOrigin = getXeroMockApiOrigin();
  if (!publicOrigin) return undefined;
  const raw = process.env.XERO_MOCK_INTERNAL_ORIGIN?.trim();
  return raw ? raw : publicOrigin;
}

function mockUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${MOCK_BASE_PATH}${path}`;
}

/**
 * Attempts for a mock self-fetch, and the pause before each retry (#2302).
 *
 * Every call in this module dials the app's OWN in-container origin
 * (`XERO_MOCK_INTERNAL_ORIGIN`, `http://127.0.0.1:3000` in CI) rather than
 * Xero's servers. That loopback hop is an artefact of the harness, and on a
 * loaded GitHub runner it intermittently fails to connect: the E2E app container
 * log for run 30530889448 shows four `TypeError: fetch failed … ECONNREFUSED`
 * bursts, and one of them landed on the organisation read behind
 * `/admin/xero/setup`'s "Connected to <Org>" confirmation. Nothing downstream
 * retries it — `fetchMockXeroOrganisation` throws, `getXeroConnectedOrganisation`
 * degrades to a null name and negative-caches for 60s, and the wizard's
 * post-OAuth `refresh()` is a one-shot mount effect — so a single refused socket
 * pinned the step on "Confirming the organisation name…" and the spec could only
 * time out.
 *
 * That was the HARNESS half. The product half — a real Xero blip pinning a real
 * operator on the same message — was fixed in #2394: the summary now carries a
 * classified `readFailure`, and the step shows it with a manual **Try again**
 * that forces a fresh read. The retry here still matters, because a mock
 * loopback refusal is an artefact of the harness that no operator should have to
 * click through in a spec.
 */
const MOCK_FETCH_ATTEMPTS = 3;
const MOCK_FETCH_RETRY_DELAY_MS = 150;

/**
 * `fetch` for the mock harness's loopback calls, retrying TRANSPORT failures
 * only (a rejected `fetch`: connection refused/reset, DNS, socket hang up).
 *
 * An HTTP response — including a 4xx/5xx — is returned untouched on the first
 * attempt: every caller here treats a non-2xx as a real fixture/gating failure
 * and must keep failing loudly rather than being masked by a retry.
 *
 * A rejected `fetch` is NOT proof the request never arrived: ECONNREFUSED means
 * it did not, but ECONNRESET / socket hang up can land after the handler already
 * ran, so a retry can genuinely repeat a served request. Safe for every caller
 * here: the reads are idempotent by nature, and the one POST with a side effect
 * — the intent-to-receive ping, which drives the real webhook route — records
 * its marker through `recordXeroWebhookValidation`, a single-row upsert keyed on
 * the provider (src/lib/xero-webhook-validation.ts), so a repeat rewrites the
 * same row rather than accumulating anything.
 *
 * Test-only by construction, like the rest of this module: nothing calls it
 * unless `XERO_MOCK_API_ORIGIN` is set, which no real deployment ever sets.
 *
 * Exported so the gated route handlers that make the SAME loopback hop (the
 * intent-to-receive ping in `/api/testing/xero-mock/send-validation`, which
 * POSTs the real webhook route) share one retry policy instead of inventing a
 * second one.
 */
export async function fetchMockLoopback(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MOCK_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (attempt < MOCK_FETCH_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, MOCK_FETCH_RETRY_DELAY_MS * attempt),
        );
      }
    }
  }
  throw lastError;
}

/**
 * Mock consent URL: points at the gated authorize endpoint, which immediately
 * redirects back to our real callback with a code + the same state, so the
 * existing callback route and its state-cookie check are exercised unchanged.
 */
export function buildMockXeroConsentUrl(origin: string, state?: string): string {
  const redirectUri = getOperationalXeroRedirectUri();
  const params = new URLSearchParams({ redirect_uri: redirectUri });
  if (state) params.set("state", state);
  return `${mockUrl(origin, "/authorize")}?${params.toString()}`;
}

/**
 * Mock token exchange + tenant read for the OAuth callback: swaps the code for a
 * token set and reads the mock connection, then stores tokens exactly like the
 * real path. Mirrors `handleXeroCallback` so the wizard's step 3 completes.
 */
export async function handleMockXeroCallback(
  origin: string,
  callbackUrl: string,
): Promise<void> {
  const code = new URL(callbackUrl).searchParams.get("code") ?? "mock-code";

  const tokenRes = await fetchMockLoopback(mockUrl(origin, "/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!tokenRes.ok) {
    throw new Error("Mock Xero token exchange failed.");
  }
  const tokenSet = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };

  const connRes = await fetchMockLoopback(mockUrl(origin, "/connections"));
  if (!connRes.ok) {
    throw new Error("Mock Xero connections read failed.");
  }
  const connections = (await connRes.json()) as Array<{ tenantId: string }>;
  const tenantId = connections[0]?.tenantId ?? null;
  if (!tenantId) {
    throw new Error(XERO_OAUTH_CALLBACK_NO_TENANT_MESSAGE);
  }

  await saveXeroTokens({
    accessToken: tokenSet.access_token,
    refreshToken: tokenSet.refresh_token,
    expiresAt: new Date(Date.now() + (tokenSet.expires_in ?? 1800) * 1000),
    tenantId,
  });
}

// Fixture chart of accounts + items the gated mock endpoints return, shared with
// the mapping-step E2E so it can assert the wizard renders real-looking pickers.
// Kept deliberately small — enough to cover the REVENUE/EXPENSE/BANK types the
// account-mapping rows filter on, plus a couple of sold items.
export const MOCK_XERO_ACCOUNTS = [
  { code: "200", name: "Hut Fees Income", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Subscription Income", type: "REVENUE", class: "REVENUE" },
  { code: "404", name: "Bank Fees", type: "EXPENSE", class: "EXPENSE" },
  { code: "090", name: "Business Bank Account", type: "BANK", class: "ASSET" },
] as const;

export const MOCK_XERO_ITEMS = [
  {
    itemID: "item-hut-fee",
    code: "HUT",
    name: "Hut Fee",
    description: "Overnight hut fee",
  },
  {
    itemID: "item-joining",
    code: "JOIN",
    name: "Joining Fee",
    description: "Membership joining fee",
  },
] as const;

/** Mock chart-of-accounts read for the mapping step. */
export async function fetchMockChartOfAccounts(
  origin: string,
): Promise<Array<{ code: string; name: string; type: string; class: string }>> {
  const res = await fetchMockLoopback(mockUrl(origin, "/chart-of-accounts"));
  if (!res.ok) return [];
  return (await res.json()) as Array<{
    code: string;
    name: string;
    type: string;
    class: string;
  }>;
}

/** Mock items read for the mapping step. */
export async function fetchMockXeroItems(
  origin: string,
): Promise<
  Array<{ itemID: string; code: string; name: string; description: string }>
> {
  const res = await fetchMockLoopback(mockUrl(origin, "/items"));
  if (!res.ok) return [];
  return (await res.json()) as Array<{
    itemID: string;
    code: string;
    name: string;
    description: string;
  }>;
}

export interface MockXeroOrganisation {
  name: string | null;
  financialYearEndMonth: number | null;
  /** Deep-link short code (#2261); absent on older mock payloads. */
  shortCode?: string | null;
}

/**
 * Mock organisation read for the step-3 "right org?" confirmation.
 *
 * THROWS when the mock endpoint errors, mirroring the live `getOrganisations`
 * path so both failure modes reach the same handler in `xero-organisation`
 * (which degrades to nulls and negative-caches the failure). Returning a silent
 * all-null summary here instead would make the mock the only path whose
 * failures are cached like a success — the asymmetry that hid #2261's F1.
 */
export async function fetchMockXeroOrganisation(
  origin: string,
): Promise<MockXeroOrganisation> {
  const res = await fetchMockLoopback(mockUrl(origin, "/organisation"));
  if (!res.ok) {
    throw new Error(
      `Mock Xero organisation read failed (HTTP ${res.status}).`,
    );
  }
  const body = (await res.json()) as MockXeroOrganisation;
  const month =
    typeof body.financialYearEndMonth === "number" &&
    body.financialYearEndMonth >= 1 &&
    body.financialYearEndMonth <= 12
      ? body.financialYearEndMonth
      : null;
  return {
    name: body.name ?? null,
    financialYearEndMonth: month,
    shortCode: typeof body.shortCode === "string" ? body.shortCode : null,
  };
}
