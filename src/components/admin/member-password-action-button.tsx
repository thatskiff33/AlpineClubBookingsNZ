"use client"

import { formatDistanceToNow } from "date-fns"
import { Button } from "@/components/ui/button"

export interface MemberPasswordActionState {
  canLogin: boolean
  hasCompletedAccountSetup: boolean
  pendingInviteExpiresAt: string | Date | null
}

export type MemberPasswordActionKind = "invite" | "resend-invite" | "reset-password"

export function getMemberPasswordActionKind(
  member: MemberPasswordActionState
): MemberPasswordActionKind | null {
  if (!member.canLogin) return null
  if (member.hasCompletedAccountSetup) return "reset-password"
  return member.pendingInviteExpiresAt ? "resend-invite" : "invite"
}

export function getMemberPasswordActionLabel(member: MemberPasswordActionState) {
  const kind = getMemberPasswordActionKind(member)
  if (kind === "reset-password") return "Reset Password"
  if (kind === "resend-invite") return "Resend Invite"
  if (kind === "invite") return "Invite"
  return null
}

function formatPendingInviteExpiry(expiresAt: string | Date) {
  return formatDistanceToNow(new Date(expiresAt), { addSuffix: true })
}

export function getMemberPasswordActionTooltip(member: MemberPasswordActionState) {
  if (getMemberPasswordActionKind(member) !== "resend-invite" || !member.pendingInviteExpiresAt) {
    return undefined
  }

  return `Sent invite expires ${formatPendingInviteExpiry(member.pendingInviteExpiresAt)} - click to send a fresh 7-day link.`
}

interface MemberPasswordActionButtonProps {
  member: MemberPasswordActionState
  onClick: () => void
}

export function MemberPasswordActionButton({
  member,
  onClick,
}: MemberPasswordActionButtonProps) {
  const label = getMemberPasswordActionLabel(member)
  if (!label) return null

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      title={getMemberPasswordActionTooltip(member)}
    >
      {label}
    </Button>
  )
}
