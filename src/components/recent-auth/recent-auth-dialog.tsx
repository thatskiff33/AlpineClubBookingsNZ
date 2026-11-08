"use client";

import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SecretInput } from "@/components/ui/secret-input";
import { apiErrorMessageFromBody, readApiErrorBody } from "@/lib/api-error-message";
import { STEP_UP_METHODS, type StepUpMethod } from "@/lib/recent-auth-policy";

/**
 * The "confirm it's you" dialog (#4616, `INV-AUTH-008`). Opened by
 * `RecentAuthProvider` when a request meets `requireRecentAuth`'s refusal; asks
 * the step-up route which method this person uses, takes it, and reports back.
 * It never sees or replays the refused request itself.
 *
 * Both fields are `SecretInput`s, so what is typed never reaches a DOM
 * attribute (`docs/SECURITY.md` → "Secret entry on pages that carry Raw CSS").
 * #4617 adds the passkey: a label below and a branch in the form, nothing else.
 */

const REAUTH_PATH = "/api/auth/reauth";

const METHOD_LABELS: Record<StepUpMethod, string> = {
  TOTP: "App code",
  PASSWORD: "Password",
};

const STEP_UP_METHOD_SET: ReadonlySet<string> = new Set(STEP_UP_METHODS);

function offeredMethods(body: unknown): StepUpMethod[] {
  const methods = (body as { methods?: unknown } | null)?.methods;
  return Array.isArray(methods)
    ? methods.filter((method): method is StepUpMethod =>
        typeof method === "string" && STEP_UP_METHOD_SET.has(method),
      )
    : [];
}

function proofBody(method: StepUpMethod, secret: string) {
  switch (method) {
    case "TOTP":
      return { method, code: secret };
    case "PASSWORD":
      return { method, password: secret };
    default: {
      const unhandled: never = method;
      throw new Error(`Unhandled step-up method: ${String(unhandled)}`);
    }
  }
}

const sixDigits = (raw: string) => raw.replace(/\D/g, "").slice(0, 6);

function StepUpForm({
  onConfirmed,
  onCancel,
}: {
  onConfirmed: () => void;
  onCancel: () => void;
}) {
  const [methods, setMethods] = useState<StepUpMethod[] | null>(null);
  const [method, setMethod] = useState<StepUpMethod | null>(null);
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(REAUTH_PATH, {
          credentials: "same-origin",
          cache: "no-store",
        });
        const body = await readApiErrorBody(response);
        if (cancelled) return;
        const offered = response.ok ? offeredMethods(body) : [];
        if (offered.length === 0) {
          setError(apiErrorMessageFromBody(body, "We couldn't load how to confirm it's you."));
          return;
        }
        setMethods(offered);
        setMethod(offered[0] ?? null);
      } catch {
        if (!cancelled) setError("We couldn't load how to confirm it's you.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!method || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(REAUTH_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proofBody(method, secret)),
      });
      if (response.ok) {
        onConfirmed();
        return;
      }
      setError(
        apiErrorMessageFromBody(await readApiErrorBody(response), "We couldn't confirm it's you."),
      );
    } catch {
      setError("We couldn't confirm it's you. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>Confirm it&apos;s you</DialogTitle>
        <DialogDescription>
          {method === "PASSWORD"
            ? "Enter your password to continue."
            : method === "TOTP"
              ? "Enter the 6-digit code from your authenticator app to continue."
              : "Checking how to confirm it's you."}
        </DialogDescription>
      </DialogHeader>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}

      {methods && methods.length > 1 ? (
        <div className="grid grid-cols-2 gap-2">
          {methods.map((choice) => (
            <Button
              key={choice}
              type="button"
              variant={choice === method ? "default" : "outline"}
              onClick={() => {
                setMethod(choice);
                setSecret("");
                setError("");
              }}
            >
              {METHOD_LABELS[choice]}
            </Button>
          ))}
        </div>
      ) : null}

      {method === "TOTP" ? (
        <div className="space-y-2">
          <Label htmlFor="step-up-code">Authenticator code</Label>
          <SecretInput
            key="TOTP"
            id="step-up-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            sanitise={sixDigits}
            onValueChange={setSecret}
          />
        </div>
      ) : method === "PASSWORD" ? (
        <div className="space-y-2">
          <Label htmlFor="step-up-password">Password</Label>
          <SecretInput
            key="PASSWORD"
            id="step-up-password"
            type="password"
            autoComplete="current-password"
            onValueChange={setSecret}
          />
        </div>
      ) : !error ? (
        <Loader2 aria-label="Loading" className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!method || secret === "" || submitting}>
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : method === "PASSWORD" ? (
            <KeyRound className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          Confirm
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Open while `requestId` is set; each request mounts a fresh form, so nothing
 * typed for one survives into the next. Closing it any way other than a
 * confirmed proof settles the request as cancelled.
 */
export function RecentAuthDialog({
  requestId,
  onSettle,
}: {
  requestId: number | null;
  onSettle: (confirmed: boolean) => void;
}) {
  return (
    <Dialog
      open={requestId !== null}
      onOpenChange={(open) => {
        if (!open) onSettle(false);
      }}
    >
      <DialogContent className="max-w-md">
        {requestId !== null ? (
          <StepUpForm
            key={requestId}
            onConfirmed={() => onSettle(true)}
            onCancel={() => onSettle(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
