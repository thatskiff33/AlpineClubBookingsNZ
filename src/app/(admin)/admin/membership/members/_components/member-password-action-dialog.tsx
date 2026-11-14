"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite"
import {
  ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS,
  DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW,
  getAdminPasswordResetExpiryLabel,
  type AdminPasswordResetExpiryWindow,
} from "@/lib/password-reset"
import type { PasswordActionTarget } from "../_types"

interface MemberPasswordActionDialogProps {
  open: boolean
  target: PasswordActionTarget | null
  onOpenChange: (open: boolean) => void
  onComplete: (message: string) => void
}

interface SetupInviteFailure {
  memberId: string
  name: string
  email: string
  error?: string
}

interface InviteResult {
  sent: number
  skipped: number
  failed: number
  failures: SetupInviteFailure[]
}

interface ResetResult {
  sent: number
  skipped: number
  expiryLabel: string
}

interface SendOutcome {
  invite: InviteResult | null
  reset: ResetResult | null
  // Set when the whole invite/reset request rejected (e.g. non-2xx response)
  // rather than reporting per-member failures.
  inviteError: string | null
  resetError: string | null
}

export function MemberPasswordActionDialog({
  open,
  target,
  onOpenChange,
  onComplete,
}: MemberPasswordActionDialogProps) {
  const [passwordActionLoading, setPasswordActionLoading] = useState(false)
  const [resetExpiryWindow, setResetExpiryWindow] = useState<AdminPasswordResetExpiryWindow>(
    DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW
  )
  const [outcome, setOutcome] = useState<SendOutcome | null>(null)
  const [pending, setPending] = useState<{ invites: number; resets: number }>({
    invites: 0,
    resets: 0,
  })
  // Ref-based double-submit guard so a rapid second click (before state
  // re-renders the disabled button) can never fire a duplicate send.
  const sendingRef = useRef(false)

  useEffect(() => {
    if (open) {
      setResetExpiryWindow(DEFAULT_ADMIN_PASSWORD_RESET_EXPIRY_WINDOW)
      setOutcome(null)
    }
  }, [open])

  const inviteCount = target?.inviteIds.length ?? 0
  const resendInviteCount = target?.resendInviteIds.length ?? 0
  const inviteTotalCount = inviteCount + resendInviteCount
  const resetCount = target?.resetIds.length ?? 0
  const allInviteIds = target ? [...target.inviteIds, ...target.resendInviteIds] : []
  const title =
    resetCount > 0 && inviteTotalCount === 0
      ? "Send Password Reset"
      : inviteTotalCount > 0 && resetCount === 0
        ? resendInviteCount > 0 && inviteCount === 0
          ? "Resend Account Setup Invite"
          : "Send Account Setup Invite"
        : "Send Login Emails"
  const buttonLabel =
    resetCount > 0 && inviteTotalCount === 0
      ? "Send Reset Email"
      : inviteTotalCount > 0 && resetCount === 0
        ? resendInviteCount > 0 && inviteCount === 0
          ? "Resend Invite"
          : "Send Invite"
        : "Send Emails"
  const description =
    inviteTotalCount > 0 && resetCount > 0
      ? `Send login emails to ${target?.label}. ${inviteCount} member(s) will receive a first-time account setup invite. ${resendInviteCount} member(s) will receive a fresh account setup invite. ${resetCount} member(s) will receive a password reset email.`
      : resetCount > 0
        ? `Send a password reset email to ${target?.label}. They will receive a link to set a new password.`
        : resendInviteCount > 0 && inviteCount === 0
          ? `Send a fresh account setup email to ${target?.label}. The current pending invite will be replaced with a new ${MEMBER_SETUP_INVITE_TTL_DAYS}-day link.`
          : `Send a first-time password setup email to ${target?.label}. They will receive a link to activate their account and choose a password (expires in ${MEMBER_SETUP_INVITE_TTL_DAYS} days).`

  const sendPasswordResetRequest = async (memberIds: string[]): Promise<ResetResult> => {
    const res = await fetch("/api/admin/members/send-password-reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds, expiryWindow: resetExpiryWindow }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      sent?: number
      skipped?: number
      expiryLabel?: string
      error?: string
    }
    if (!res.ok) throw new Error(data.error || "Failed to send password reset")
    return {
      sent: data.sent ?? 0,
      skipped: data.skipped ?? 0,
      expiryLabel: data.expiryLabel ?? getAdminPasswordResetExpiryLabel(resetExpiryWindow),
    }
  }

  const sendSetupInviteRequest = async (memberIds: string[]): Promise<InviteResult> => {
    const res = await fetch("/api/admin/members/send-setup-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberIds }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      sent?: number
      skipped?: number
      failed?: number
      results?: Array<{
        memberId: string
        email: string
        name: string
        status: "sent" | "failed"
        error?: string
      }>
      error?: string
    }
    if (!res.ok) throw new Error(data.error || "Failed to send setup invite")
    const perMember = data.results ?? []
    const failures: SetupInviteFailure[] = perMember
      .filter((result) => result.status === "failed")
      .map((result) => ({
        memberId: result.memberId,
        name: result.name,
        email: result.email,
        error: result.error,
      }))
    return {
      sent: data.sent ?? 0,
      skipped: data.skipped ?? 0,
      failed: data.failed ?? failures.length,
      failures,
    }
  }

  const buildSuccessMessage = (result: SendOutcome): string => {
    const messages: string[] = []
    if (result.invite) {
      messages.push(
        result.invite.skipped > 0
          ? `Sent ${result.invite.sent} setup invite(s). ${result.invite.skipped} skipped (inactive or non-login).`
          : `Sent ${result.invite.sent} setup invite(s).`
      )
    }
    if (result.reset) {
      messages.push(
        result.reset.skipped > 0
          ? `Sent ${result.reset.sent} password reset email(s) with a ${result.reset.expiryLabel} window. ${result.reset.skipped} skipped (inactive or non-login).`
          : `Sent ${result.reset.sent} password reset email(s) with a ${result.reset.expiryLabel} window.`
      )
    }
    return messages.join(" ")
  }

  const performSend = async (inviteMemberIds: string[], resetMemberIds: string[]) => {
    if (sendingRef.current) return
    if (inviteMemberIds.length === 0 && resetMemberIds.length === 0) return
    sendingRef.current = true
    setPasswordActionLoading(true)
    setPending({ invites: inviteMemberIds.length, resets: resetMemberIds.length })
    setOutcome(null)

    const inviteOperation =
      inviteMemberIds.length > 0 ? sendSetupInviteRequest(inviteMemberIds) : Promise.resolve(null)
    const resetOperation =
      resetMemberIds.length > 0 ? sendPasswordResetRequest(resetMemberIds) : Promise.resolve(null)

    const [inviteResult, resetResult] = await Promise.allSettled([
      inviteOperation,
      resetOperation,
    ])

    const next: SendOutcome = {
      invite: null,
      reset: null,
      inviteError: null,
      resetError: null,
    }

    if (inviteResult.status === "fulfilled") {
      next.invite = inviteResult.value
    } else {
      next.inviteError =
        inviteResult.reason instanceof Error
          ? inviteResult.reason.message
          : "Failed to send setup invite"
    }

    if (resetResult.status === "fulfilled") {
      next.reset = resetResult.value
    } else {
      next.resetError =
        resetResult.reason instanceof Error
          ? resetResult.reason.message
          : "Failed to send password reset"
    }

    sendingRef.current = false
    setPasswordActionLoading(false)

    const sentTotal = (next.invite?.sent ?? 0) + (next.reset?.sent ?? 0)
    const hasFailure =
      Boolean(next.inviteError) ||
      Boolean(next.resetError) ||
      (next.invite?.failed ?? 0) > 0

    if (sentTotal > 0 && !hasFailure) {
      // Full success: keep the existing behavior — toast + auto-close.
      onComplete(buildSuccessMessage(next))
      onOpenChange(false)
      return
    }

    // Pure failure (nothing sent) or partial success: keep the dialog open and
    // render the outcome inside it so failures are never hidden behind the
    // page-level banner and overlay.
    setOutcome(next)
  }

  const handleSendPasswordAction = () => {
    if (!target) return
    void performSend(allInviteIds, target.resetIds)
  }

  const handleRetry = () => {
    if (!target || !outcome) return
    // Retry only what still needs sending: every invite id when the whole
    // invite request failed, otherwise just the members whose email rejected;
    // and the reset ids only when the reset request itself failed. This avoids
    // re-emailing members who already succeeded.
    const inviteRetryIds = outcome.inviteError
      ? allInviteIds
      : outcome.invite?.failures.map((failure) => failure.memberId) ?? []
    const resetRetryIds = outcome.resetError ? target.resetIds : []
    void performSend(inviteRetryIds, resetRetryIds)
  }

  const isRetryable = Boolean(
    outcome &&
      (outcome.inviteError ||
        outcome.resetError ||
        (outcome.invite?.failures.length ?? 0) > 0)
  )
  const inviteSent = outcome?.invite?.sent ?? 0
  const resetSent = outcome?.reset?.sent ?? 0
  const skippedTotal = (outcome?.invite?.skipped ?? 0) + (outcome?.reset?.skipped ?? 0)

  const progressParts: string[] = []
  if (pending.invites > 0) progressParts.push(`${pending.invites} invite(s)`)
  if (pending.resets > 0) progressParts.push(`${pending.resets} reset email(s)`)
  const progressText = `Sending ${progressParts.join(" and ")}…`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {resetCount > 0 && !outcome && (
          <div className="space-y-2">
            <Label htmlFor="reset-expiry-window">Reset link expiry</Label>
            <Select
              value={resetExpiryWindow}
              onValueChange={(value) =>
                setResetExpiryWindow(value as AdminPasswordResetExpiryWindow)
              }
              disabled={passwordActionLoading}
            >
              <SelectTrigger id="reset-expiry-window">
                <SelectValue placeholder="Select expiry" />
              </SelectTrigger>
              <SelectContent>
                {ADMIN_PASSWORD_RESET_EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              This applies to password reset emails only. The current selection expires in{" "}
              {getAdminPasswordResetExpiryLabel(resetExpiryWindow)}.
            </p>
          </div>
        )}

        {passwordActionLoading && (
          <p role="status" className="text-sm text-muted-foreground">
            {progressText}
          </p>
        )}

        {outcome && !passwordActionLoading && (
          <div className="space-y-3 text-sm">
            {(inviteSent > 0 || resetSent > 0 || skippedTotal > 0) && (
              <div className="space-y-1">
                {inviteSent > 0 && (
                  <p className="text-success-11">Sent {inviteSent} setup invite(s).</p>
                )}
                {resetSent > 0 && (
                  <p className="text-success-11">
                    Sent {resetSent} password reset email(s) with a{" "}
                    {outcome.reset?.expiryLabel} window.
                  </p>
                )}
                {skippedTotal > 0 && (
                  <p className="text-muted-foreground">
                    {skippedTotal} skipped (inactive or non-login).
                  </p>
                )}
              </div>
            )}
            {isRetryable && (
              <div
                role="alert"
                className="space-y-2 rounded-md border border-danger-6 bg-danger-3 p-3 text-danger-11"
              >
                {outcome.inviteError && <p>{outcome.inviteError}</p>}
                {outcome.invite && outcome.invite.failures.length > 0 && (
                  <div className="space-y-1">
                    <p className="font-medium">
                      {outcome.invite.failed} setup invite(s) failed to send:
                    </p>
                    <ul className="list-disc space-y-0.5 pl-5">
                      {outcome.invite.failures.map((failure) => (
                        <li key={failure.memberId}>
                          {failure.name} ({failure.email})
                          {failure.error ? ` — ${failure.error}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {outcome.resetError && <p>{outcome.resetError}</p>}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {outcome ? (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={passwordActionLoading}
              >
                Close
              </Button>
              {isRetryable && (
                <Button onClick={handleRetry} disabled={passwordActionLoading}>
                  {passwordActionLoading ? "Sending..." : "Retry"}
                </Button>
              )}
            </>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={passwordActionLoading}
              >
                Cancel
              </Button>
              <Button onClick={handleSendPasswordAction} disabled={passwordActionLoading}>
                {passwordActionLoading ? "Sending..." : buttonLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
