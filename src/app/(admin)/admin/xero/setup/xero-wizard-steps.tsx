"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, requireInstant, type BoundClubTime } from "@/lib/club-time";
import { ConnectionStatusPanel } from "../_components/connection-status-panel";
import { useXeroConnection } from "../_hooks/use-xero-connection";
import type {
  XeroOrgReadError,
  XeroWizardContext,
} from "./use-xero-wizard-context";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";
const CONNECT_RETURN = "/admin/xero/setup";

// A credential's "set at" is a real INSTANT, shown in the club's persisted zone
// rather than the viewer's or the build's (CT-4, #2870; INV-CONFIG-002).
function formatSetAt(clubTime: BoundClubTime, setAt: string | null): string {
  if (!setAt) return "";
  const instant = parseInstant(setAt);
  return instant === null ? "" : clubTime.instantDate(instant);
}

function LegacyEnvWarning({ vars }: { vars: string[] }) {
  if (vars.length === 0) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        These legacy environment variables are no longer used and are ignored:{" "}
        <code className="rounded bg-warning-3 px-1">{vars.join(", ")}</code>.
        Enter the credentials in-app here, then remove them from the environment.
      </span>
    </div>
  );
}

/** Step 1 — "Create your Xero app": portal-mirroring instructions + copy fields. */
export function CreateAppStep({ context }: { context: XeroWizardContext }) {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Create your Xero app
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          In a new tab, open the{" "}
          <a
            href="https://developer.xero.com/app/manage"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Xero developer portal
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>{" "}
          and choose <strong>New app</strong> &rarr; <strong>Web app</strong>.
          Use the exact values below — copy each one so nothing is mistyped.
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      <CopyField
        label="App name (suggested)"
        value="Club Bookings"
        monospace={false}
        description="Any name works; this is just what shows in your Xero developer portal."
      />
      <CopyField
        label="Company or application URL"
        value={context.companyUrl}
        emptyHint="Set NEXTAUTH_URL to your site URL to fill this in."
        description="Your booking site's address."
      />
      <CopyField
        label="OAuth 2.0 redirect URI"
        value={context.redirectUri}
        emptyHint="Set NEXTAUTH_URL so the redirect URI can be derived."
        description="Paste this EXACTLY into the Redirect URIs field. It must match what the app sends, or Xero rejects the connection."
      />

      <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Which scopes / sections?</p>
        <p className="mt-1">
          One app covers everything this integration needs — contacts, invoices,
          payments, settings and finance reports. You do not create separate apps
          for accounting and finance; the connection step requests the right
          scopes for you.
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        When the app is created, Xero shows a <strong>Client id</strong> and lets
        you generate a <strong>Client secret</strong>. Keep that tab open and
        continue to the next step to enter them here.
      </p>
    </div>
  );
}

/** Step 2 — "Enter credentials": write-only Client ID / Secret → C1 API. */
export function CredentialsStep({
  context,
  helpers,
}: {
  context: XeroWizardContext;
  helpers: WizardStepHelpers;
}) {
  const clubTime = useClubTime();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const canWrite = context.isFullAdmin;
  const bothSet =
    context.credentials.client_id.set && context.credentials.client_secret.set;

  async function writeField(key: string, value: string): Promise<void> {
    const res = await fetch(CREDENTIALS_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "xero", key, value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(data?.error || `Failed to save ${key}.`);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Write only the fields the operator actually filled in (Replace flow).
      if (clientId.trim()) await writeField("client_id", clientId.trim());
      if (clientSecret.trim())
        await writeField("client_secret", clientSecret.trim());
      setClientId("");
      setClientSecret("");
      setSuccess(
        "Credentials saved. Any existing Xero connection was reset — reconnect on the next step.",
      );
      helpers.refresh();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save.",
      );
    } finally {
      setSaving(false);
    }
  }

  const dirty = Boolean(clientId.trim() || clientSecret.trim());

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Enter your Xero credentials
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the Client id and generate a Client secret in your Xero app, then
          enter them here. They are encrypted at rest and never shown again —
          entering a new value replaces the old one and{" "}
          <strong>resets the Xero connection</strong> (you re-connect on the next
          step).
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      {canWrite === false ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can enter or replace Xero
            credentials. You can view the status here.
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="xero-wizard-client-id">Client ID</Label>
          <span className="text-xs">
            {context.credentials.client_id.set ? (
              <span className="text-success-11">
                Set ✓{" "}
                {formatSetAt(clubTime, context.credentials.client_id.setAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </span>
        </div>
        <Input
          id="xero-wizard-client-id"
          type="text"
          autoComplete="off"
          placeholder={
            context.credentials.client_id.set
              ? "Enter a new value to replace"
              : "Xero app client ID"
          }
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={canWrite !== true || saving}
        />
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="xero-wizard-client-secret">Client Secret</Label>
          <span className="text-xs">
            {context.credentials.client_secret.set ? (
              <span className="text-success-11">
                Set ✓{" "}
                {formatSetAt(clubTime, context.credentials.client_secret.setAt)}
              </span>
            ) : (
              <span className="text-muted-foreground">Not set</span>
            )}
          </span>
        </div>
        <Input
          id="xero-wizard-client-secret"
          type="password"
          autoComplete="off"
          placeholder={
            context.credentials.client_secret.set
              ? "Enter a new value to replace"
              : "Xero app client secret"
          }
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={canWrite !== true || saving}
        />
      </div>

      {/* Live regions stay PERMANENTLY mounted and only their content swaps, so
          the message is announced when it appears (a region injected already
          populated is dropped by some SR/browser pairings — AGENTS.md live-region
          rule / PolicyFeedback convention). The styled box exists only when there
          is a message, so the empty region takes no visible space. */}
      <div role="alert">
        {error ? (
          <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            {error}
          </div>
        ) : null}
      </div>
      <div role="status">
        {success ? (
          <div className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11">
            {success}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {/* KEEPS its own reason (#2324). The shell's banner states `finance`;
            writing a credential additionally needs Full Admin, so a
            finance-edit admin without it meets no banner and a dead button.
            Before #2324 this was a plain disabled Button that said nothing at
            all. */}
        <ViewOnlyActionButton
          type="button"
          canEdit={canWrite}
          readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
        >
          {saving
            ? "Saving…"
            : bothSet
              ? "Replace credentials"
              : "Save credentials"}
        </ViewOnlyActionButton>
        {bothSet ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Both credentials stored
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "about 40 seconds" / "about 3 minutes" / "about 5 hours" — a rounded, spoken
 * wait for a Retry-After. Deliberately vague: Xero's own value is advisory, so
 * a to-the-second countdown would claim precision nobody has.
 */
function describeWait(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  const hours = Math.max(1, Math.round(seconds / 3600));
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/**
 * "Checked once, at 2:32 pm." / "Checked 3 times, most recently at 2:32 pm."
 *
 * Not decoration (#2394 review, F5). Every failure of the same class otherwise
 * renders byte-identical text, so React mutates no DOM node and the `role=alert`
 * region announces NOTHING on a repeat — worst on the daily limit, where the
 * wording cannot change for hours. The count is what guarantees a change; the
 * time is what makes it useful.
 */
function describeChecks(clubTime: BoundClubTime, attempts: number, at: number | null): string | null {
  if (at === null || attempts < 1) return null;
  // `at` is epoch milliseconds — a real INSTANT — so the club's persisted zone
  // decides which wall-clock time an operator reads (CT-4, #2870).
  const time = clubTime.instantTime(requireInstant(at));
  return attempts === 1
    ? `Checked once, at ${time}.`
    : `Checked ${attempts} times, most recently at ${time}.`;
}

/**
 * Plain-English account of a failed organisation check, and whether trying again
 * could possibly help.
 *
 * The kinds exist because they need DIFFERENT actions from the operator —
 * reconnect, wait, sign in, press the button, or ask for access — so this never
 * collapses to "something went wrong" (the owner's binding decision on #2394).
 *
 * Every sentence here must be something the code actually KNOWS (#2394 review,
 * F6). Only `unavailable` reflects an answer from Xero; `check_failed`,
 * `signed_out` and `forbidden` are all this site failing or refusing, and none
 * of them may vouch for the Xero connection, because none of them asked it
 * anything.
 */
function describeOrgReadError(error: XeroOrgReadError): {
  heading: string;
  detail: string;
  canRetry: boolean;
} {
  switch (error.kind) {
    case "disconnected":
      return {
        heading: "Xero needs re-authorising.",
        detail:
          "The stored authorisation is no longer accepted — usually because it was revoked in Xero, or the app's security key changed. Use Disconnect Xero above (if it is offered), then Connect again and choose your organisation. Trying again without reconnecting will not help.",
        canRetry: false,
      };
    case "rate_limited": {
      if (error.rateLimit === "day") {
        // ONE answer to "when should I come back", not two (F7). Xero omits
        // Retry-After on plenty of daily 429s, and our retry layer then
        // fabricates 86400 — so quoting it produced "resets at midnight UTC …
        // Xero suggests waiting about 24 hours" in the same breath. The reset
        // time is the real answer and is always available, so it is the only
        // one given.
        return {
          heading: "Xero's daily limit for your organisation has been reached.",
          detail:
            "Xero caps how many requests an app may make each day, and that cap resets at midnight UTC — around midday in New Zealand — so this should clear then. Setup is safe to leave and come back to; nothing you have entered is lost.",
          canRetry: true,
        };
      }
      const when = error.retryAfterSeconds
        ? `Xero asked us to wait ${describeWait(error.retryAfterSeconds)}.`
        : "Wait about a minute.";
      return {
        heading: "Xero is limiting how quickly we can ask it for information.",
        detail: `${when} This is Xero's short per-minute limit, usually because something else — a sync, or another reconnect — is busy at the same time. Try again after that; retrying straight away only makes the limit last longer.`,
        canRetry: true,
      };
    }
    case "forbidden":
      return {
        heading: "Your admin role cannot read the Xero organisation details.",
        detail:
          "Reading the connected organisation needs finance access. Ask a full admin to finish this step, or to give your role finance access first. Trying again will not change this.",
        canRetry: false,
      };
    case "signed_out":
      // Split out from `forbidden` (F8). Both used to say "ask for finance
      // access", but a 401 means the SESSION went, not the role — and this is
      // the likelier of the two to be seen, because a plain permission problem
      // fails the status read first and never reaches here.
      return {
        heading: "Your sign-in has expired, so we could not check the organisation.",
        detail:
          "Sign in again — in another tab is fine — then press Try again. Nothing you have entered in this wizard is lost, and your Xero connection is unaffected.",
        canRetry: true,
      };
    case "check_failed":
      // We never got an answer out of THIS site, so we never asked Xero
      // anything. Saying "we could not reach Xero" here would be a guess, and
      // when the browser is simply offline it would be flatly wrong (F6).
      return {
        heading: "We could not check your Xero organisation just now.",
        detail:
          "This page could not get an answer from the site itself, so nothing was asked of Xero — your connection may well be fine. Check your internet connection, then press Try again.",
        canRetry: true,
      };
    case "unavailable":
    default: {
      // Source-neutral wording for the wait (F7): this kind covers both Xero's
      // own advice and OUR process-wide cooldown after a run of failures, and
      // the message cannot tell which. "Give it N" is true either way, where
      // "Xero suggests waiting N" was not.
      const when = error.retryAfterSeconds
        ? ` Give it ${describeWait(error.retryAfterSeconds)} before trying again.`
        : "";
      return {
        heading: "We could not reach Xero just now to confirm your organisation name.",
        detail: `This is almost always temporary — a brief outage, a dropped connection, or a short pause we take after repeated failures.${when} Nothing you have entered is lost.`,
        canRetry: true,
      };
    }
  }
}

/** Step 3 — "Connect": OAuth flow + connected-organisation confirmation. */
export function ConnectStep({
  context,
  helpers,
}: {
  context: XeroWizardContext;
  helpers: WizardStepHelpers;
}) {
  // `connectionError` covers BOTH a failed status read and the `?error=` the
  // OAuth callback redirects back with. Before #2394 this step called the hook
  // and never rendered either, so a refused authorisation came back to a wizard
  // that simply said "Not Connected" with no hint of what Xero had objected to.
  const clubTime = useClubTime();
  const { status, handleDisconnect, error: connectionError } =
    useXeroConnection();

  // NO post-OAuth effect here any more (#2394 review, F1). `?connected=true` is
  // read AND stripped once by `useXeroWizardContext`, which folds the forced
  // organisation read into its own first load. Doing it here re-fired every time
  // the operator walked back to this step — the shell mounts only the active
  // step and `goTo` never navigates, so the parameter was still in the URL —
  // spending a live Xero call each time with nobody pressing anything, and it
  // also made the post-connect return cost two live reads instead of one.

  const orgFailure = context.orgError
    ? describeOrgReadError(context.orgError)
    : null;
  const orgChecks = orgFailure
    ? describeChecks(clubTime, context.orgErrorAttempts, context.orgErrorAt)
    : null;

  // The other half of the focus story (F3). Keeping Try again enabled means it
  // holds focus while it works — but a SUCCESSFUL retry removes the whole
  // failure box, unmounting the button under the operator's focus and dropping
  // it to <body> after all. So a press that clears the failure hands focus to
  // the confirmation it produced, which is the next thing worth reading. Armed
  // only by an actual click, so nothing steals focus on an ordinary load.
  const retryPressedRef = useRef(false);
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!retryPressedRef.current) return;
    if (context.orgError !== null || context.orgLoading) return;
    retryPressedRef.current = false;
    confirmationRef.current?.focus();
  }, [context.orgError, context.orgLoading]);

  const onConnect = () => {
    window.location.href = `/api/admin/xero/connect?return=${encodeURIComponent(
      CONNECT_RETURN,
    )}`;
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">
          Connect to Xero
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Authorise the app with Xero. You will be sent to Xero to choose the
          organisation, then returned here.
        </p>
      </div>

      <ConnectionStatusPanel
        status={status}
        onConnect={onConnect}
        onDisconnect={handleDisconnect}
        // Connect / reconnect / disconnect mutate the finance integration, so
        // gate them on finance edit access. The wizard shell renders the
        // view-only banner above (same finance scope), so the disabled controls
        // are explained without a per-button reason.
        canEdit={helpers.canEdit}
      />

      {/* Live regions stay PERMANENTLY mounted and only their content swaps, so
          the message is announced when it appears (AGENTS.md live-region rule /
          the CredentialsStep convention above). Both sit OUTSIDE the
          `context.connected` branch below: a load that failed before it learned
          whether Xero is connected still has something to say, and a region
          that is itself conditional is a region screen readers never adopted. */}
      <div role="alert">
        {connectionError ? (
          <div className="flex items-start gap-2 rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{connectionError}</span>
          </div>
        ) : null}
      </div>

      <div role="alert">
        {orgFailure ? (
          <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                <strong>{orgFailure.heading}</strong> {orgFailure.detail}
                {orgChecks ? <> {orgChecks}</> : null}
              </span>
            </div>
            {orgFailure.canRetry ? (
              <div className="mt-3">
                {/* Not permission-gated, like the Verify control on the
                    webhooks step: this reads the organisation name, it changes
                    nothing, and the wizard already performs the same read on
                    load for any admin who can open the page. Gating it would
                    leave a view-only admin looking at an error with no way to
                    clear it. It IS the only thing on this page that spends Xero
                    quota on demand, which is exactly the owner's decision on
                    #2394: a human press, never an automatic retry.

                    NOT disabled while busy (#2394 review, F3) — the house rule
                    from `restore-built-ins.tsx` and AGENTS.md. `orgLoading`
                    flips in the same turn as the click, so a disabled button
                    cannot keep focus and the browser drops it to <body>: a
                    keyboard or screen-reader operator would lose their place in
                    the one state where pressing again is the point. The label
                    and `aria-busy` carry the busy state, and a re-entrant press
                    is dropped by the in-flight ref inside the wizard-context
                    hook — so this stays exactly one live call per press. */}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-busy={context.orgLoading}
                  onClick={() => {
                    retryPressedRef.current = true;
                    helpers.refresh();
                  }}
                >
                  {context.orgLoading ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden />
                      Trying again…
                    </>
                  ) : (
                    "Try again"
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {context.connected ? (
        // Green ONLY when the organisation was actually confirmed. A failed
        // check beside a cached name used to render the full success tick, so
        // an authorisation revoked inside Xero read as "all set" on the very
        // step that exists to confirm it (#2394 review, F4).
        <div
          ref={confirmationRef}
          // Focus target only (the effect above), never in the tab order —
          // the same shape as the wizard shell's step container.
          tabIndex={-1}
          className={cn(
            "flex items-start gap-2 rounded-md border p-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            orgFailure
              ? "border-border bg-muted text-muted-foreground"
              : "border-success-6 bg-success-3 text-success-11",
          )}
        >
          {orgFailure ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          )}
          <span>
            {context.orgName ? (
              orgFailure ? (
                <>
                  The last organisation we saw was{" "}
                  <strong>{context.orgName}</strong>, but we could not re-check
                  that just now — see above. Treat it as the last name we read,
                  not as confirmation.
                </>
              ) : (
                <>
                  Connected to <strong>{context.orgName}</strong>. Check this is
                  the right Xero organisation — if not, disconnect above and
                  reconnect, choosing the correct one.
                </>
              )
            ) : orgFailure ? (
              // The warning box above already says what went wrong and what to
              // do. Repeating "Confirming…" underneath it would contradict it.
              <>Connected to Xero. The organisation name could not be read — see above.</>
            ) : (
              <>
                Connected to Xero. Confirming the organisation name…
              </>
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}
