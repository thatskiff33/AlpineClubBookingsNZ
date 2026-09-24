"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFullAdminEditAccess } from "@/hooks/use-admin-area-edit-access";

/**
 * Derives the Xero setup wizard's server truth (#2080) — the `context` the
 * reusable shell verifies each step against. Everything here is LIVE server
 * state (credential metadata, connection status, connected org name), so step
 * gating can never be faked by a stale persisted cursor.
 */

export interface XeroCredentialFieldMeta {
  set: boolean;
  setAt: string | null;
}

/**
 * Why the connected-organisation read did not produce a confirmed name (#2394).
 *
 * The first three kinds mirror `XeroOrganisationReadFailure` on the server
 * (`src/lib/xero-organisation.ts`) — they are the three things an operator can
 * do something DIFFERENT about after we DID reach Xero: reconnect, wait, or try
 * again now. The last three are client-only, and none of them involves Xero at
 * all:
 *
 * - `forbidden` — this site refused (HTTP 403): the admin's role has no finance
 *   access. No amount of retrying or waiting will change it.
 * - `signed_out` — this site refused (HTTP 401, or the 404 a module-gated route
 *   answers an anonymous caller with): the SESSION is missing or expired, which
 *   is a different problem with a different fix (sign in again), and one a retry
 *   genuinely does clear (#2394 review, F8).
 * - `check_failed` — we never got an answer out of our OWN server, so we never
 *   even asked Xero: the status read failed, the browser is offline, or the
 *   response would not parse. Crucially this must NOT claim the Xero connection
 *   is fine, because we did not check it (#2394 review, F6).
 *
 * Kept as a hand-written mirror rather than importing the server type: this
 * module is a client component, and `xero-organisation.ts` pulls in the Xero
 * client and Prisma. `normaliseOrgFailure` below is the one place the wire
 * shape is trusted, so an unknown kind degrades rather than rendering nothing.
 */
export type XeroOrgReadErrorKind =
  | "disconnected"
  | "rate_limited"
  | "unavailable"
  | "forbidden"
  | "signed_out"
  | "check_failed";

export interface XeroOrgReadError {
  kind: XeroOrgReadErrorKind;
  /** Which Xero limit was hit, for `rate_limited` (else null). */
  rateLimit: "minute" | "day" | null;
  /** Seconds Xero asked us to wait, when it said (else null). */
  retryAfterSeconds: number | null;
}

export type XeroCredentialKey = "client_id" | "client_secret" | "webhook_key";

export interface XeroWizardContext {
  /** Resolved OAuth redirect URI (from NEXTAUTH_URL, server-provided). */
  redirectUri: string;
  /** Company URL suggestion — the deployment origin behind the redirect URI. */
  companyUrl: string;
  /** Legacy XERO_* env vars still present (server-detected); empty when clean. */
  legacyEnvVars: string[];
  /** Metadata-only credential status (never a value). */
  credentials: Record<XeroCredentialKey, XeroCredentialFieldMeta>;
  /**
   * Whether the viewer may write credentials (Full Admin only). Tri-state
   * (#2065 / #2324): `undefined` while the session resolves, so a step neither
   * flashes "Only a Full Admin can…" at a Full Admin nor flashes an enabled
   * control at anyone else. Treat only `true` as permission.
   */
  isFullAdmin: boolean | undefined;
  /** Xero OAuth connection state. */
  connected: boolean;
  /** Stored tokens exist but no longer decrypt (auth secret changed). */
  needsReentry: boolean;
  /**
   * The last organisation name we managed to read, when there is one.
   *
   * NOT a promise that it is current: a failed read still serves the last known
   * summary (see `XeroConnectedOrganisation.readFailure`), so a name can arrive
   * beside an {@link orgError}. Read the pair together — a name with an error
   * means "this is what we last saw, and here is why we could not re-check it"
   * (#2394 review, F4).
   */
  orgName: string | null;
  /**
   * Why the organisation could not be CONFIRMED, or null when it was (#2394).
   * The connect step shows the "Confirming the organisation name…" placeholder
   * only while this is null and a read is in flight; any settled failure
   * replaces it with an explanation and, where one could help, a Try again
   * control.
   *
   * Set independently of {@link orgName}: a stale-but-usable name must never
   * silently swallow a real failure, which is exactly how a revoked-in-Xero
   * authorisation used to render as a green "Connected to <club>" tick.
   */
  orgError: XeroOrgReadError | null;
  /**
   * When the current {@link orgError} was recorded (epoch ms), else null.
   *
   * Exists so a REPEAT failure of the same class changes something on the page
   * (#2394 review, F5). Without it the rendered text is byte-identical, React
   * mutates no DOM node, and the `role="alert"` region announces nothing at all
   * — so a screen-reader operator pressing Try again during a daily limit gets
   * silence, and a sighted one gets a label flicker.
   */
  orgErrorAt: number | null;
  /** Consecutive failed organisation checks; 0 while there is no failure. */
  orgErrorAttempts: number;
  /**
   * True while a context load — which performs the organisation read when
   * connected — is in flight. Set for the WHOLE load rather than just the org
   * fetch: the load starts with three parallel reads before it even knows
   * whether Xero is connected, and a Try again button that stays idle-looking
   * for that first round-trip reads as a dead button.
   *
   * Drives `aria-busy` on that button, never `disabled` — re-entrancy is
   * dropped inside the hook instead (see the in-flight ref in `load`).
   */
  orgLoading: boolean;
  /** Webhook delivery URL to paste into the Xero portal ({origin}/api/webhooks/xero). */
  webhookDeliveryUrl: string;
  /**
   * Whether this deployment can actually verify webhooks: a public HTTPS origin
   * (not localhost / not plain HTTP). When false the step explains why and
   * defaults to Skip.
   */
  webhooksVerifiable: boolean;
  /** Persistent webhook verification (marker matches the current key). */
  webhookVerified: boolean;
}

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials?provider=xero";
const STATUS_ENDPOINT = "/api/admin/xero/status";
const ORG_ENDPOINT = "/api/admin/xero/organisation";
const WEBHOOK_STATUS_ENDPOINT = "/api/admin/xero/webhook/verify-status";

const EMPTY_META: XeroCredentialFieldMeta = { set: false, setAt: null };

interface CredentialsResponse {
  credentials?: Record<string, { set?: boolean; setAt?: string }>;
}
interface StatusResponse {
  connected?: boolean;
  needsReentry?: boolean;
}
interface OrgResponse {
  name?: string | null;
  readFailure?: {
    kind?: string;
    rateLimit?: string | null;
    retryAfterSeconds?: number | null;
  } | null;
}

/** The three server kinds, as a runtime set for the wire-shape check below. */
const SERVER_ORG_FAILURE_KINDS = new Set([
  "disconnected",
  "rate_limited",
  "unavailable",
]);

/** Trust nothing off the wire: an unrecognised shape degrades to "try again". */
function normaliseOrgFailure(
  raw: OrgResponse["readFailure"],
): XeroOrgReadError {
  const kind =
    typeof raw?.kind === "string" && SERVER_ORG_FAILURE_KINDS.has(raw.kind)
      ? (raw.kind as XeroOrgReadErrorKind)
      : "unavailable";
  const rateLimit =
    raw?.rateLimit === "minute" || raw?.rateLimit === "day"
      ? raw.rateLimit
      : null;
  const retryAfterSeconds =
    typeof raw?.retryAfterSeconds === "number" &&
    Number.isFinite(raw.retryAfterSeconds) &&
    raw.retryAfterSeconds > 0
      ? Math.ceil(raw.retryAfterSeconds)
      : null;
  return { kind, rateLimit, retryAfterSeconds };
}

/** A bare failure of one kind, with no wait and no limit scope. */
function plainFailure(kind: XeroOrgReadErrorKind): XeroOrgReadError {
  return { kind, rateLimit: null, retryAfterSeconds: null };
}

/**
 * The query parameter the Xero OAuth callback redirects back with, and the one
 * thing that makes a post-connect load force a fresh organisation read.
 */
const CONNECT_RETURN_PARAM = "connected";

/**
 * Read the post-OAuth marker and STRIP it from the address bar in one go, so it
 * can be acted on exactly once (#2394 review, F1).
 *
 * The stripping is the whole point. `IntegrationWizard` mounts only the ACTIVE
 * step and `goTo` is pure client state — no navigation — so a step effect that
 * merely READS `?connected=true` re-fires every time the operator walks back to
 * the Connect step, forcing a live Xero call each time with nobody pressing
 * anything. That contradicted the owner's binding decision on #2394 (no Xero
 * quota spent unless a human presses) in the very change that documented it.
 *
 * Consuming it HERE rather than in the step also collapses the post-connect
 * return from two live reads to one: the wizard shell blocks the step until the
 * context has loaded, so a step-level force always landed AFTER the hook's own
 * mount read had already gone to Xero.
 *
 * `history.replaceState` (not `router.replace`) matches `login/magic`'s
 * consumed-token strip: no re-render, no RSC round-trip, and every other
 * parameter — `?step=`, and the `?error=` the connect step still renders — is
 * preserved untouched.
 */
function takeConnectReturnMarker(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get(CONNECT_RETURN_PARAM) !== "true") return false;
  params.delete(CONNECT_RETURN_PARAM);
  const query = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
  return true;
}

interface WebhookStatusResponse {
  verified?: boolean;
}

export interface XeroWizardServerConfig {
  redirectUri: string;
  companyUrl: string;
  legacyEnvVars: string[];
  /** {origin}/api/webhooks/xero, or "" when no NEXTAUTH_URL origin is resolvable. */
  webhookDeliveryUrl: string;
  /** Public-HTTPS, non-localhost origin (webhooks can actually validate here). */
  webhooksVerifiable: boolean;
}

export function useXeroWizardContext(serverConfig: XeroWizardServerConfig): {
  context: XeroWizardContext;
  loading: boolean;
  refresh: () => void;
} {
  // Tri-state: `undefined` until the session resolves (#2324). Reading an
  // unresolved session as `false` made every step's Full-Admin notice appear
  // and then vanish for an actual Full Admin. The shared hook is the one home
  // for that reading (#3596); it answers `false` for a signed-out session too.
  const isFull = useFullAdminEditAccess();

  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState<
    Record<XeroCredentialKey, XeroCredentialFieldMeta>
  >({
    client_id: EMPTY_META,
    client_secret: EMPTY_META,
    webhook_key: EMPTY_META,
  });
  const [connected, setConnected] = useState(false);
  const [needsReentry, setNeedsReentry] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<XeroOrgReadError | null>(null);
  const [orgErrorAt, setOrgErrorAt] = useState<number | null>(null);
  const [orgErrorAttempts, setOrgErrorAttempts] = useState(0);
  const [orgLoading, setOrgLoading] = useState(true);
  const [webhookVerified, setWebhookVerified] = useState(false);

  /**
   * Re-entrancy guard for {@link load}, held in a REF rather than enforced by
   * disabling the Try again button (#2394 review, F3).
   *
   * The house rule is `restore-built-ins.tsx` / `AGENTS.md`: a control that is
   * disabled in the same turn as the click cannot hold focus, so the browser
   * drops focus to `<body>` and a keyboard or screen-reader operator loses their
   * place — in the one state where pressing again is the whole point. The button
   * therefore stays enabled and only says it is busy; a second press lands here
   * and is dropped, so N presses can never become N live Xero calls.
   */
  const loadInFlightRef = useRef(false);

  const load = useCallback(async (forceOrgRefresh = false) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setOrgLoading(true);
    // Every settled failure below re-stamps these, INCLUDING a repeat of the
    // same class, so the rendered message always changes and the alert region
    // is actually re-announced (F5).
    const reportOrgFailure = (error: XeroOrgReadError) => {
      setOrgError(error);
      setOrgErrorAt(Date.now());
      setOrgErrorAttempts((previous) => previous + 1);
    };
    const clearOrgFailure = () => {
      setOrgError(null);
      setOrgErrorAt(null);
      setOrgErrorAttempts(0);
    };
    try {
      const [credRes, statusRes, webhookRes] = await Promise.all([
        fetch(CREDENTIALS_ENDPOINT, { credentials: "same-origin" }),
        fetch(STATUS_ENDPOINT, { credentials: "same-origin" }),
        fetch(WEBHOOK_STATUS_ENDPOINT, { credentials: "same-origin" }),
      ]);

      if (credRes.ok) {
        const data = (await credRes.json()) as CredentialsResponse;
        const rows = data.credentials ?? {};
        setCredentials({
          client_id: {
            set: Boolean(rows.client_id?.set),
            setAt: rows.client_id?.setAt ?? null,
          },
          client_secret: {
            set: Boolean(rows.client_secret?.set),
            setAt: rows.client_secret?.setAt ?? null,
          },
          webhook_key: {
            set: Boolean(rows.webhook_key?.set),
            setAt: rows.webhook_key?.setAt ?? null,
          },
        });
      }

      let isConnected = false;
      // Whether the status read ANSWERED, as distinct from what it answered.
      // Without the distinction a failed status read looks exactly like
      // "disconnected", which then clears the organisation name and leaves the
      // step waiting on a read it decided not to make (#2394).
      let connectionKnown = false;
      if (statusRes.ok) {
        const data = (await statusRes.json()) as StatusResponse;
        isConnected = Boolean(data.connected);
        connectionKnown = true;
        setConnected(isConnected);
        setNeedsReentry(Boolean(data.needsReentry));
      }

      if (webhookRes.ok) {
        const data = (await webhookRes.json()) as WebhookStatusResponse;
        setWebhookVerified(Boolean(data.verified));
      }

      // Only read the org (a Xero API call) when actually connected. An explicit
      // refresh (post-connect return, post-credential save, the Try again
      // control) forces a fresh read (?refresh=1) so a just-reconnected
      // DIFFERENT org can never show the old cached name — belt-and-braces over
      // the server-side cache reset (#2080 F1) — and so a manual retry is never
      // answered out of the 60-second NEGATIVE cache a failure just wrote
      // (#2394). A Try again that re-serves the failure it was pressed to clear
      // is worse than no button at all.
      if (isConnected) {
        const orgUrl = forceOrgRefresh
          ? `${ORG_ENDPOINT}?refresh=1`
          : ORG_ENDPOINT;
        const orgRes = await fetch(orgUrl, { credentials: "same-origin" });
        if (orgRes.ok) {
          const data = (await orgRes.json()) as OrgResponse;
          const name = data.name ?? null;
          // Never blank a name on a failure: the server already serves the last
          // known one, and losing it would be a regression on top of a blip.
          if (name) setOrgName(name);
          if (data.readFailure) {
            // Reported EVEN WITH a name (#2394 review, F4). The name that
            // arrives beside a failure is the last one we read, served out of a
            // cache the failed read fell back to — it is not a confirmation.
            // Suppressing the failure because a name happened to be present is
            // how a `disconnected` (the club revoked the app inside Xero's own
            // Connected-apps screen, so our token row still looks healthy)
            // rendered as a green "Connected to <club>" tick on the very step
            // whose job is confirming the authorisation.
            reportOrgFailure(normaliseOrgFailure(data.readFailure));
          } else if (name) {
            clearOrgFailure();
          } else {
            // The read genuinely succeeded and Xero reported no name at all.
            // Vanishingly rare, but it must not fall back into an endless
            // "Confirming…" — that is the bug this issue is about.
            setOrgName(null);
            reportOrgFailure(plainFailure("unavailable"));
          }
        } else if (orgRes.status === 401 || orgRes.status === 404) {
          // THIS SITE refused because the SESSION is gone, not because of the
          // role — a different problem with a different fix, and one a retry
          // really can clear once the operator signs in again (F8).
          //
          // 404 lands here too. `/api/admin/xero/*` is module-gated, so an
          // anonymous caller is answered with the gate's own 404 rather than a
          // 401 (`moduleGatedNotFoundResponse` in `src/lib/session-guards.ts`),
          // which is what stops one anonymous request reading a club's module
          // list. The only other cause of a 404 here is the Xero module being
          // switched off — and this wizard lives at `/admin/xero/setup`, which
          // is gated by that same flag, so the wizard could not have rendered
          // in that state. Inside the wizard, a 404 means the sign-in went.
          reportOrgFailure(plainFailure("signed_out"));
        } else if (orgRes.status === 403) {
          // THIS SITE refused, not Xero: the signed-in admin has no finance
          // access. Retrying and waiting are both useless, so this is its own
          // case rather than a mislabelled "temporarily unavailable".
          reportOrgFailure(plainFailure("forbidden"));
        } else {
          // Our OWN route failed. We never learned anything about Xero, so this
          // must not be dressed up as "Xero is unavailable" (F6).
          reportOrgFailure(plainFailure("check_failed"));
        }
      } else if (connectionKnown) {
        // Positively not connected: there is no organisation to name and
        // nothing to report.
        setOrgName(null);
        clearOrgFailure();
      } else {
        // The status read failed, so we never learned whether Xero is
        // connected — and therefore never even attempted the organisation
        // read. Keep whatever name we already had (it is the last thing we
        // knew) and say the CHECK did not happen, rather than blanking the name
        // into a "Confirming…" that nothing will ever resolve. Deliberately not
        // "we could not reach Xero": we never asked it anything.
        reportOrgFailure(plainFailure("check_failed"));
      }
    } catch {
      // The load itself failed (offline, a dropped connection, unparseable
      // JSON). Everything else degrades to "not verified", which still leaves
      // the operator a control to press — but the organisation confirmation
      // degrades to a message that never resolves, so it has to say so and
      // offer the retry (#2394). Before this, the bare `catch {}` here meant a
      // single blip pinned the step permanently with nothing shown and nothing
      // logged. Again `check_failed`, not `unavailable`: when the browser is
      // offline, "your Xero connection itself is fine" is a claim we cannot
      // make and the retry cannot succeed either (F6).
      reportOrgFailure(plainFailure("check_failed"));
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
      setOrgLoading(false);
    }
  }, []);

  useEffect(() => {
    // The ONE place the post-OAuth marker is acted on, and it is consumed as it
    // is read (#2394 review, F1). Returning from Xero forces a fresh
    // organisation read — the org identity may have just changed — but an
    // ordinary page load, and every later revisit of the Connect step, rides
    // the server cache and costs no live Xero call.
    void load(takeConnectReturnMarker());
  }, [load]);

  // A user-triggered refresh always forces a fresh org read: post-credential-
  // save the org identity may have just changed, and the Try again control on
  // the connect step (#2394) must escape the 60-second negative cache a failed
  // read leaves behind.
  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const context: XeroWizardContext = {
    redirectUri: serverConfig.redirectUri,
    companyUrl: serverConfig.companyUrl,
    legacyEnvVars: serverConfig.legacyEnvVars,
    credentials,
    isFullAdmin: isFull,
    connected,
    needsReentry,
    orgName,
    orgError,
    orgErrorAt,
    orgErrorAttempts,
    orgLoading,
    webhookDeliveryUrl: serverConfig.webhookDeliveryUrl,
    webhooksVerifiable: serverConfig.webhooksVerifiable,
    webhookVerified,
  };

  return { context, loading, refresh };
}
