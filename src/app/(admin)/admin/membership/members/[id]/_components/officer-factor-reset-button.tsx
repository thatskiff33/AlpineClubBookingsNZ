"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { FocusedActionError } from "@/components/focused-action-error";
import { Button } from "@/components/ui/button";
import { isKioskSessionMember } from "@/lib/member-roles";
import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";
import { REAUTH_REQUIRED_CODE } from "@/lib/recent-auth";

/**
 * The reset button where it may be offered: the officer sign-in release is
 * on, the viewer is a Full Admin, it is not their own account, and the member
 * is not the lodge kiosk. Otherwise nothing.
 */
export function OfficerFactorResetSlot({
  member,
  isSelf,
  actorIsFullAdmin,
}: {
  member: Parameters<typeof isKioskSessionMember>[0] & { id: string };
  isSelf: boolean;
  actorIsFullAdmin: boolean;
}) {
  if (!OFFICER_SIGN_IN_ENFORCED || !actorIsFullAdmin || isSelf) return null;
  if (isKioskSessionMember(member)) return null;
  return <OfficerFactorResetButton memberId={member.id} />;
}

/**
 * Full Admin only. Resets another member's authenticator and passkeys (#4618).
 * The member never sees this control, and it is not offered on your own account
 * or on the lodge kiosk.
 */
export function OfficerFactorResetButton({ memberId }: { memberId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");

  async function reset() {
    setPending(true);
    setMessage("");
    setFailure("");
    try {
      const response = await fetchWithRecentAuth(
        `/api/admin/security/two-factor-reset/${memberId}`,
        { method: "POST", credentials: "same-origin" },
      );
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;
      if (!response.ok) {
        setFailure(
          body?.code === REAUTH_REQUIRED_CODE
            ? "The reset needs you to confirm it's you first."
            : (body?.error ?? "The reset did not run."),
        );
        return;
      }
      setMessage("Their authenticator and passkeys were reset, and their sessions ended.");
      router.refresh();
    } catch {
      setFailure("The reset did not run.");
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
      {/* Success is polite; a failure is an alert, styled as one (#4620). */}
      <p role="status" className="text-sm">
        {message}
      </p>
      <FocusedActionError id={`factor-reset-error-${memberId}`} error={failure} />
    </div>
  );
}
