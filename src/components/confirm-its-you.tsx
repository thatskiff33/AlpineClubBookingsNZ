"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isReauthFactor,
  isReauthRequiredPayload,
  type ReauthFactor,
} from "@/lib/recent-auth";

/**
 * Opens the confirm dialog and resolves once the person has proved themselves,
 * or false if they cancel or the dialog is not mounted.
 */
type PendingConfirmation = {
  resolve: (proved: boolean) => void;
};

let pending: PendingConfirmation | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function askToConfirmIdentity(): Promise<boolean> {
  if (!listeners.size) return Promise.resolve(false);
  return new Promise((resolve) => {
    if (pending) pending.resolve(false);
    pending = { resolve };
    emit();
  });
}

async function responseRequiresReauth(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    return isReauthRequiredPayload(await response.clone().json());
  } catch {
    return false;
  }
}

/**
 * Fetch, and if the server answers with the recent-auth refusal, ask the
 * person to confirm and send the same request once more.
 *
 * The body is the caller's body, unchanged, and it is sent at most twice:
 * the original attempt and one replay. A second refusal is returned as-is.
 * The body has to be reusable (a string); a stream would already be spent.
 */
export async function fetchWithRecentAuth(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const firstInput = input instanceof Request ? input.clone() : input;
  const first = await fetch(firstInput, init);
  if (!(await responseRequiresReauth(first))) return first;
  const proved = await askToConfirmIdentity();
  if (!proved) return first;
  const secondInput = input instanceof Request ? input.clone() : input;
  return fetch(secondInput, init);
}

/**
 * The passkey ceremony (#4617). Until that lands there is no assertion, and
 * the server refuses the proof.
 */
async function buildPasskeyAssertion(): Promise<unknown> {
  return null;
}

function finish(proved: boolean) {
  const current = pending;
  pending = null;
  emit();
  current?.resolve(proved);
}

export function ConfirmItsYouHost() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (!pending) return null;
  return <ConfirmItsYouDialog onDone={finish} />;
}

function ConfirmItsYouDialog({ onDone }: { onDone: (proved: boolean) => void }) {
  const [factors, setFactors] = useState<ReauthFactor[] | null>(null);
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingProof, setPendingProof] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/reauth");
        const body: unknown = await response.json();
        const listed =
          typeof body === "object" &&
          body !== null &&
          "factors" in body &&
          Array.isArray((body as { factors?: unknown }).factors)
            ? (body as { factors: unknown[] }).factors.filter(isReauthFactor)
            : [];
        if (!cancelled) {
          if (!response.ok || listed.length === 0) {
            setError("Confirming isn't available right now.");
            setFactors([]);
          } else {
            setFactors(listed);
          }
        }
      } catch {
        if (!cancelled) {
          setError("Confirming isn't available right now.");
          setFactors([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const factor = factors?.[0] ?? null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!factor || pendingProof) return;
    setPendingProof(true);
    setError(null);
    try {
      const payload =
        factor === "PASSWORD"
          ? { factor, password: secret }
          : factor === "PASSKEY"
            ? { factor, assertion: await buildPasskeyAssertion() }
            : { factor, code: secret };
      const response = await fetch("/api/auth/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (response.ok) {
        onDone(true);
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : "That didn't match. Try again.";
      setError(message);
      setPendingProof(false);
    } catch {
      setError("That didn't match. Try again.");
      setPendingProof(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDone(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{"Confirm it's you"}</DialogTitle>
          <DialogDescription>
            This session needs a fresh confirmation before it can continue.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          {factor === "TOTP" ? (
            <div className="space-y-2">
              <Label htmlFor="reauth-code">Authenticator code</Label>
              <Input
                id="reauth-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </div>
          ) : null}
          {factor === "PASSWORD" ? (
            <div className="space-y-2">
              <Label htmlFor="reauth-password">Password</Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </div>
          ) : null}
          {factor === "PASSKEY" ? (
            <p className="text-sm text-muted-foreground">
              {"Use your passkey to confirm it's you."}
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onDone(false)}
              disabled={pendingProof}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pendingProof || !factor}>
              {factor === "PASSKEY" ? "Use your passkey" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
