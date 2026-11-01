"use client";

import { useState } from "react";
import { Copy, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RetiredRecoveryCodesNotice } from "@/components/retired-recovery-codes-notice";

export function TwoFactorSecurityCard({
  enabled,
  method,
  moduleEnabled,
  recoveryCodesRetired = false,
}: {
  enabled: boolean;
  method: "TOTP" | "EMAIL" | null;
  moduleEnabled: boolean;
  /** The member's saved recovery codes were retired by a key change (#4456). */
  recoveryCodesRetired?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

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

  const methodLabel =
    method === "TOTP"
      ? "Authenticator app"
      : method === "EMAIL"
        ? "Email code"
        : "Not set";
  const statusDescription = enabled
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
            <Badge variant={enabled ? "success" : "secondary"}>
              {enabled ? "Enabled" : "Not enrolled"}
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
