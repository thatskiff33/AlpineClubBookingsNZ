"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { REAUTH_REQUIRED_CODE } from "@/lib/recent-auth";

/**
 * Full Admin only. Resets another member's authenticator and passkeys (#4618).
 * The member never sees this control, and it is not offered on your own account
 * or on the lodge kiosk.
 */
export function OfficerFactorResetButton({ memberId }: { memberId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function reset() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/security/two-factor-reset/${memberId}`,
        { method: "POST", credentials: "same-origin" },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      if (!response.ok) {
        setMessage(
          body?.code === REAUTH_REQUIRED_CODE
            ? "Confirm it's you, then try the reset again."
            : (body?.error ?? "The reset did not run."),
        );
        return;
      }
      setMessage("Their authenticator and passkeys were reset, and their sessions ended.");
      router.refresh();
    } catch {
      setMessage("The reset did not run.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => void reset()}>
        {pending ? "Resetting…" : "Reset two-factor"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Ends their sessions and emails them. Their next sign-in goes to set-up,
        with no new grace period.
      </p>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
