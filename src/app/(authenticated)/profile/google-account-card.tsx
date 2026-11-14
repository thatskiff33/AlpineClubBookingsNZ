"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FocusedActionError } from "@/components/focused-action-error";

/**
 * Profile "Connected accounts" control for Google sign-in (#2035). Rendered in
 * the Security card alongside two-factor. Linking is profile-initiated: the
 * member (already signed in) starts the OAuth round-trip from here.
 *
 *   Connect → POST /api/profile/google/link/start (sets a signed, HttpOnly
 *   link-intent cookie bound to this member) → signIn("google"). The signIn
 *   callback reads the cookie on the OAuth callback and pins Member.googleSub
 *   WITHOUT switching the session identity, then redirects back here.
 *
 *   Disconnect → POST /api/profile/google/unlink (nulls googleSub, audited).
 *   Password login always remains, so disconnecting never strands the member.
 */
export function GoogleAccountCard({
  linked,
  moduleEnabled,
  credentialsConfigured = true,
}: {
  linked: boolean;
  moduleEnabled: boolean;
  credentialsConfigured?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // The Connect affordance is only meaningful when the module is on AND the
  // per-club Google credentials are configured server-side — mirror the login
  // page, which hides "Continue with Google" under the same condition. Without
  // this the button would show but the start route refuses with a generic error.
  const canConnect = moduleEnabled && credentialsConfigured;

  async function connect() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/profile/google/link/start", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError("Could not start Google linking. Please try again.");
        setLoading(false);
        return;
      }
      // Full-page OAuth round-trip. The intent cookie is already set; on return
      // the signIn callback pins the sub and redirects to /profile.
      await signIn("google", { callbackUrl: "/profile#security" });
    } catch {
      setError("Could not start Google linking. Please try again.");
      setLoading(false);
    }
  }

  async function disconnect() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/profile/google/unlink", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!res.ok) {
        setError("Could not disconnect Google. Please try again.");
        setLoading(false);
        return;
      }
      window.location.assign("/profile#security");
    } catch {
      setError("Could not disconnect Google. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Google account</span>
            <Badge variant={linked ? "success" : "secondary"}>
              {linked ? "Connected" : "Not connected"}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {linked
              ? "You can sign in with this Google account. Password sign-in still works."
              : canConnect
                ? "Connect your Google account to sign in with Google. This never replaces your password."
                : moduleEnabled
                  ? "Google sign-in is enabled but not yet configured by your club, so linking is unavailable right now."
                  : "Google sign-in is currently turned off by your club."}
          </p>
        </div>
        {linked ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void disconnect()}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Disconnect
          </Button>
        ) : canConnect ? (
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={() => void connect()}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Connect Google
          </Button>
        ) : null}
      </div>

      <FocusedActionError id="google-account-error" error={error} />
    </div>
  );
}
