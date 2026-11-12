"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { Copy, Fingerprint, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RetiredRecoveryCodesNotice } from "@/components/retired-recovery-codes-notice";
import { apiErrorMessageFromResponse } from "@/lib/api-error-message";
import { isSecondFactorEnrolled } from "@/lib/second-factor-enrolment";

export type ProfilePasskey = {
  id: string;
  name: string;
  createdAtLabel: string;
};

export function TwoFactorSecurityCard({
  enabled,
  method,
  moduleEnabled,
  passkeys,
  recoveryCodesRetired = false,
}: {
  enabled: boolean;
  method: "TOTP" | "EMAIL" | null;
  moduleEnabled: boolean;
  passkeys: ProfilePasskey[];
  /** The member's saved recovery codes were retired by a key change (#4456). */
  recoveryCodesRetired?: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [passkeyName, setPasskeyName] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const enrolled = isSecondFactorEnrolled({
    twoFactorEnabled: enabled,
    hasPasskey: passkeys.length > 0,
    sessionEnrolled: false,
  });

  async function regenerate() {
    setLoading(true);
    setError("");
    setCodes(null);
    setCopied(false);
    try {
      const response = await fetch("/api/auth/2fa/recovery/regenerate", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Failed to regenerate recovery codes");
      }
      const body = (await response.json()) as { recoveryCodes: string[] };
      setCodes(body.recoveryCodes);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to regenerate recovery codes",
      );
    } finally {
      setLoading(false);
    }
  }

  async function copyCodes() {
    if (!codes) return;
    await navigator.clipboard.writeText(codes.join("\n"));
    setCopied(true);
  }

  async function addPasskey() {
    setLoading(true);
    setError("");
    try {
      const optionsResponse = await fetch("/api/auth/2fa/webauthn/register/options", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!optionsResponse.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(optionsResponse, "That passkey didn't work. Try again."),
        );
      }
      const optionsJSON: unknown = await optionsResponse.json();
      const credential = await startRegistration({
        optionsJSON: optionsJSON as Parameters<typeof startRegistration>[0]["optionsJSON"],
      });
      const verifyResponse = await fetch("/api/auth/2fa/webauthn/register/verify", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: credential,
          ...(passkeyName.trim() ? { name: passkeyName.trim() } : {}),
        }),
      });
      if (!verifyResponse.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(verifyResponse, "That passkey didn't work. Try again."),
        );
      }
      setPasskeyName("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That passkey didn't work. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function removePasskey(id: string) {
    setRemovingId(id);
    setError("");
    try {
      const response = await fetch(`/api/auth/2fa/webauthn/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) {
        throw new Error(
          await apiErrorMessageFromResponse(response, "That passkey is no longer saved."),
        );
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That passkey is no longer saved.");
    } finally {
      setRemovingId(null);
    }
  }

  const methodLabel =
    method === "TOTP"
      ? "Authenticator app"
      : method === "EMAIL"
        ? "Email code"
        : passkeys.length > 0
          ? "Passkey"
          : "Not set";
  const statusDescription = enrolled
    ? moduleEnabled
      ? `Method: ${methodLabel}`
      : `Method: ${methodLabel}. The club currently has two-factor sign-in disabled, but your account remains enrolled.`
    : "Enrollment is required the next time the club enables two-factor authentication.";

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Two-factor authentication</span>
            <Badge variant={enrolled ? "success" : "secondary"}>
              {enrolled ? "Enabled" : "Not enrolled"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {statusDescription}
          </p>
        </div>
        {enabled ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void regenerate()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            Regenerate codes
          </Button>
        ) : null}
      </div>

      {recoveryCodesRetired && enabled && !codes ? (
        <RetiredRecoveryCodesNotice>
          Choose Regenerate codes to get a new set, and keep it somewhere safe.
        </RetiredRecoveryCodesNotice>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Passkeys</p>
        {passkeys.length === 0 ? (
          <p className="text-xs text-muted-foreground">No passkey saved.</p>
        ) : (
          <ul className="space-y-2">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm">{passkey.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {passkey.createdAtLabel}
                  </p>
                </div>
                <Button
                  size="sm"
                  type="button"
                  variant="outline"
                  disabled={removingId === passkey.id}
                  onClick={() => void removePasskey(passkey.id)}
                >
                  {removingId === passkey.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="passkey-name">Passkey name</Label>
            <Input
              id="passkey-name"
              maxLength={64}
              value={passkeyName}
              onChange={(event) => setPasskeyName(event.target.value)}
              placeholder="Passkey"
            />
          </div>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => void addPasskey()}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Fingerprint className="h-4 w-4" />}
            Add passkey
          </Button>
        </div>
      </div>

      {codes ? (
        <div className="space-y-3 rounded-md border bg-muted p-3">
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {codes.map((code) => (
              <div key={code}>{code}</div>
            ))}
          </div>
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void copyCodes()}
          >
            <Copy className="h-4 w-4" />
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
