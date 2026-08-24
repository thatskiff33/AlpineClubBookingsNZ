"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyField } from "@/components/admin/integration-wizard";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import type {
  StripeCredentialKey,
  StripeWizardContext,
} from "./use-stripe-wizard-context";

const CREDENTIALS_ENDPOINT = "/api/admin/integrations/credentials";

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

function SetStatus({ set, setAt }: { set: boolean; setAt: string | null }) {
  const clubTime = useClubTime();
  return (
    <span className="text-xs">
      {set ? (
        <span className="text-success-11">Set ✓ {formatSetAt(clubTime, setAt)}</span>
      ) : (
        <span className="text-muted-foreground">Not set</span>
      )}
    </span>
  );
}

async function writeCredential(key: StripeCredentialKey, value: string): Promise<void> {
  const res = await fetch(CREDENTIALS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "stripe", key, value }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error || `Failed to save ${key}.`);
  }
}

/** Step 1 — "Find your Stripe keys": portal-mirroring instructions. */
export function PortalGuideStep({ context }: { context: StripeWizardContext }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Find your Stripe API keys
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          In a new tab, open your{" "}
          <a
            href="https://dashboard.stripe.com/apikeys"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Stripe API keys
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>{" "}
          page. Use <strong>Test mode</strong> while you set this up (toggle at
          the top of the Stripe dashboard) — you can switch to live keys later.
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Which keys do I need?</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            The <strong>Publishable key</strong> (<code>pk_test_…</code>) — safe
            to share; it identifies your account to the card form.
          </li>
          <li>
            The <strong>Secret key</strong> (<code>sk_test_…</code>) — kept
            encrypted and never shown again. You can{" "}
            <a
              href="https://dashboard.stripe.com/apikeys/create"
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
            >
              create a restricted key
            </a>{" "}
            instead if you prefer to limit its scope, as long as it can read the
            account and create payment intents, refunds and customers.
          </li>
        </ul>
      </div>

      <p className="text-sm text-muted-foreground">
        Keep the Stripe tab open and continue to the next step to enter the keys
        here.
      </p>
    </div>
  );
}

/** Step 2 — "Enter keys": write-only secret + publishable → C1 API. */
export function CredentialsStep({
  context,
  helpers,
}: {
  context: StripeWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [secretKey, setSecretKey] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  /*
    #2264 — the key SHAPE ("sk_test_…") is an example and now sits under the
    field; the "Enter a new value to replace" branch stays a placeholder because
    it is an instruction about this control's own behaviour once a credential is
    already stored.
  */
  const secretKeyHint = useFieldHint();
  const publishableKeyHint = useFieldHint();

  const canWrite = context.isFullAdmin;
  const bothSet =
    context.credentials.secret_key.set &&
    context.credentials.publishable_key.set;

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      // Write only the fields the operator actually filled in (Replace flow).
      if (secretKey.trim()) await writeCredential("secret_key", secretKey.trim());
      if (publishableKey.trim())
        await writeCredential("publishable_key", publishableKey.trim());
      setSecretKey("");
      setPublishableKey("");
      setSuccess(
        "Keys saved. Any previous webhook verification was reset — re-verify on the webhook step.",
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

  const dirty = Boolean(secretKey.trim() || publishableKey.trim());

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Enter your Stripe keys
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste the Secret key and Publishable key from the Stripe dashboard. The
          secret key is encrypted at rest and never shown again; entering a new
          value replaces the old one. The publishable key is delivered to the
          card form at runtime (it is not secret).
        </p>
      </div>

      <LegacyEnvWarning vars={context.legacyEnvVars} />

      {context.needsReentry ? (
        <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            A stored Stripe key can no longer be read (the app encryption key
            changed). Re-enter the keys below to restore payments.
          </span>
        </div>
      ) : null}

      {canWrite === false ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can enter or replace Stripe keys.
            You can view the status here.
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="stripe-wizard-secret-key">Secret key</Label>
          <SetStatus
            set={context.credentials.secret_key.set}
            setAt={context.credentials.secret_key.setAt}
          />
        </div>
        <Input
          id="stripe-wizard-secret-key"
          type="password"
          autoComplete="off"
          placeholder={
            context.credentials.secret_key.set
              ? "Enter a new value to replace"
              : undefined
          }
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          disabled={canWrite !== true || saving}
          {...secretKeyHint.fieldProps}
        />
        <FieldHint {...secretKeyHint.hintProps}>Example: sk_test_…</FieldHint>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="stripe-wizard-publishable-key">Publishable key</Label>
          <SetStatus
            set={context.credentials.publishable_key.set}
            setAt={context.credentials.publishable_key.setAt}
          />
        </div>
        <Input
          id="stripe-wizard-publishable-key"
          type="text"
          autoComplete="off"
          placeholder={
            context.credentials.publishable_key.set
              ? "Enter a new value to replace"
              : undefined
          }
          value={publishableKey}
          onChange={(e) => setPublishableKey(e.target.value)}
          disabled={canWrite !== true || saving}
          {...publishableKeyHint.fieldProps}
        />
        <FieldHint {...publishableKeyHint.hintProps}>
          Example: pk_test_…
        </FieldHint>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
        >
          {error}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11"
        >
          {success}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        {/* KEEPS its own reason (#2324): Full Admin, not the banner's
            `finance` scope. Before #2324 this was a plain disabled Button. */}
        <ViewOnlyActionButton
          type="button"
          canEdit={canWrite}
          readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : bothSet ? "Replace keys" : "Save keys"}
        </ViewOnlyActionButton>
        {bothSet ? (
          <span className="inline-flex items-center gap-1 text-sm text-success-11">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Both keys stored
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Step 3 — "Verify connection": live account read + right-account confirmation. */
export function VerifyConnectionStep({
  context,
  helpers,
}: {
  context: StripeWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [checking, setChecking] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Verify the connection
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          We use your secret key to read your Stripe account and confirm it is
          the right one before taking any payments.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        disabled={checking}
        onClick={() => {
          setChecking(true);
          helpers.refresh();
          // The context reload is async; clear the local spinner shortly after.
          setTimeout(() => setChecking(false), 1500);
        }}
      >
        {checking ? "Checking…" : "Check connection"}
      </Button>

      {context.connected ? (
        <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {context.accountName ? (
              <>
                Connected to <strong>{context.accountName}</strong>. Check this
                is the right Stripe account — if not, replace the secret key on
                the previous step with one from the correct account.
              </>
            ) : (
              <>Connected to Stripe. Confirming the account name…</>
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Not connected yet. Enter a valid secret key on the previous step,
            then check the connection.
          </span>
        </div>
      )}
    </div>
  );
}

/** Step 4 — "Webhook" (optional/skippable): endpoint URL + signing secret + test event. */
export function WebhookStep({
  context,
  helpers,
}: {
  context: StripeWizardContext;
  helpers: WizardStepHelpers;
}) {
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // #2264 — same split as the key fields: the example shape becomes a hint, the
  // "replace" instruction stays a placeholder.
  const webhookSecretHint = useFieldHint();

  const canWrite = context.isFullAdmin;

  async function handleSave() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      if (webhookSecret.trim())
        await writeCredential("webhook_secret", webhookSecret.trim());
      setWebhookSecret("");
      setSuccess(
        "Signing secret saved. Send a test event from Stripe, then re-check below.",
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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold text-foreground">
          Set up the payment webhook
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          The webhook keeps bookings in sync when payments succeed, fail, or are
          refunded. In Stripe, open{" "}
          <a
            href="https://dashboard.stripe.com/webhooks"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
          >
            Developers → Webhooks
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          , add an endpoint with the URL below — or, if this site already has
          one there (an upgrade from env-configured Stripe), reuse it and paste
          back its existing signing secret rather than creating a second
          endpoint. This step is optional — you can skip it and set it up
          later.
        </p>
      </div>

      <CopyField
        label="Endpoint URL"
        value={context.webhookEndpointUrl}
        emptyHint="Set NEXTAUTH_URL so the endpoint URL can be derived."
        description="Paste this into the Stripe webhook endpoint URL field."
      />

      {canWrite === false ? (
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Only a <strong>Full Admin</strong> can enter the signing secret.
          </span>
        </div>
      ) : null}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="stripe-wizard-webhook-secret">
            Signing secret
          </Label>
          <SetStatus
            set={context.credentials.webhook_secret.set}
            setAt={context.credentials.webhook_secret.setAt}
          />
        </div>
        <Input
          id="stripe-wizard-webhook-secret"
          type="password"
          autoComplete="off"
          placeholder={
            context.credentials.webhook_secret.set
              ? "Enter a new value to replace"
              : undefined
          }
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          disabled={canWrite !== true || saving}
          {...webhookSecretHint.fieldProps}
        />
        <FieldHint {...webhookSecretHint.hintProps}>
          Example: whsec_…
        </FieldHint>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11"
        >
          {error}
        </div>
      ) : null}
      {success ? (
        <div
          role="status"
          className="rounded-md border border-success-6 bg-success-3 px-3 py-2 text-sm text-success-11"
        >
          {success}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {/* KEEPS its own reason (#2324): Full Admin, not `finance`. */}
        <ViewOnlyActionButton
          type="button"
          canEdit={canWrite}
          readOnlyReason={ADMIN_FULL_ADMIN_ONLY_ACTION_REASON}
          onClick={() => void handleSave()}
          disabled={!webhookSecret.trim() || saving}
        >
          {saving ? "Saving…" : "Save signing secret"}
        </ViewOnlyActionButton>
        <Button
          type="button"
          variant="outline"
          onClick={() => helpers.refresh()}
        >
          Re-check verification
        </Button>
      </div>

      {context.webhookVerified ? (
        <div className="flex items-start gap-2 rounded-md border border-success-6 bg-success-3 p-3 text-sm text-success-11">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Verified — a Stripe test event reached this app and its signature
            checked out.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {context.credentials.webhook_secret.set
              ? "Signing secret saved but no test event has verified yet. In Stripe, use “Send test webhook” on your endpoint, then re-check."
              : "Not verified yet. Add the signing secret above, send a Stripe test event, then re-check. You can skip this step for now."}
          </span>
        </div>
      )}
    </div>
  );
}
