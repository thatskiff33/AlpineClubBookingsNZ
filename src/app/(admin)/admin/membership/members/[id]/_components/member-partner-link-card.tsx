"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  ViewOnlyActionButton,
  type AncestorViewOnlyBannerProps,
} from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { HeartHandshake, Trash2 } from "lucide-react"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { useDebouncedMemberSearch } from "@/hooks/use-debounced-member-search"
import type {
  SerializedPartnerLinkState,
  SerializedPartnerLinkView,
} from "@/lib/partner-link-views"

import { adminHref } from "@/lib/admin-hubs";
interface PartnerSearchResult {
  id: string
  firstName: string
  lastName: string
  email: string
}

interface MemberPartnerLinkCardProps extends AncestorViewOnlyBannerProps {
  memberId: string
  isAdultMember: boolean
  memberIsArchived: boolean
  currentMemberPath: string
  className?: string
}

/**
 * Admin view of a member's declared Partner/Husband/Wife relationship
 * (#1742): shows the confirmed link and pending requests, assigns a partner
 * directly (CONFIRMED immediately, no consent round-trip), and removes links.
 */
export function MemberPartnerLinkCard({
  memberId,
  isAdultMember,
  memberIsArchived,
  currentMemberPath,
  className,
  ancestorRendersViewOnlyBanner = false,
}: MemberPartnerLinkCardProps) {
  const router = useRouter()
  // Assign/remove write /api/admin/members/[id]/partner-link (membership area);
  // a view-only membership admin sees the link but cannot change it (#1997).
  const canEdit = useAdminAreaEditAccess("membership")
  const [state, setState] = useState<SerializedPartnerLinkState | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState("")
  // #1769a: which action is waiting on the admin's notify-or-not choice, and
  // whether the dialog is open. Only assign and CONFIRMED-remove open it — a
  // PENDING remove sends no email so it never asks. The choice is kept set
  // while the dialog fades out (Radix keeps the content mounted through its
  // exit animation) so the copy never flickers to the other action's wording.
  const [notifyChoice, setNotifyChoice] = useState<
    | { kind: "assign"; partnerMemberId: string }
    | { kind: "remove"; linkId: string }
    | null
  >(null)
  const [notifyDialogOpen, setNotifyDialogOpen] = useState(false)

  // partnerLinkEligibleFor filters server-side (active adults, not this
  // member, no existing confirmed partner) so a page of results is never
  // emptied by client-side filtering.
  const {
    results: searchResults,
    searching,
    error: searchError,
  } = useDebouncedMemberSearch<PartnerSearchResult>({
    query: search,
    enabled: assignOpen,
    params: { pageSize: "8", partnerLinkEligibleFor: memberId },
  })

  async function loadState() {
    const res = await fetch(`/api/admin/members/${memberId}/partner-link`)
    if (!res.ok) return
    setState(await res.json())
  }

  useEffect(() => {
    loadState().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId])

  async function performAssign(partnerMemberId: string, notifyMember: boolean) {
    setError("")
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/members/${memberId}/partner-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partnerMemberId, notifyMember }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to assign partner")
        return
      }
      toast.success(
        (data.message || "Partner assigned") +
          (notifyMember === false ? " The members were not emailed." : "")
      )
      setAssignOpen(false)
      setSearch("")
      await loadState()
    } finally {
      setSaving(false)
    }
  }

  // #1769a: a CONFIRMED link removal emails both members, so it routes through
  // the notify-choice dialog; a PENDING removal emails no one, so it removes
  // directly (no dialog, no notifyMember flag).
  function handleRemove(linkId: string, confirmed: boolean) {
    if (confirmed) {
      openNotifyChoice({ kind: "remove", linkId })
    } else {
      void performRemove(linkId)
    }
  }

  // #1769a: open the notify-choice dialog for a given action.
  function openNotifyChoice(
    choice:
      | { kind: "assign"; partnerMemberId: string }
      | { kind: "remove"; linkId: string }
  ) {
    setNotifyChoice(choice)
    setNotifyDialogOpen(true)
  }

  async function performRemove(linkId: string, notifyMember?: boolean) {
    setError("")
    setRemovingId(linkId)
    try {
      const res = await fetch(
        `/api/admin/members/${memberId}/partner-link?id=${encodeURIComponent(linkId)}`,
        {
          method: "DELETE",
          // Only send a body when there is a notify choice to convey; a bodyless
          // DELETE preserves today's silent PENDING removal.
          ...(notifyMember !== undefined
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notifyMember }),
              }
            : {}),
        }
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || "Failed to remove partner link")
        return
      }
      toast.success(
        (data.message || "Partner link removed") +
          (notifyMember === false ? " The members were not emailed." : "")
      )
      await loadState()
    } finally {
      setRemovingId(null)
    }
  }

  // #1769a: dispatch the pending notify choice to the right action. Close the
  // dialog without clearing the choice, so the content keeps its wording while
  // it fades out.
  function confirmNotify(notify: boolean) {
    const choice = notifyChoice
    setNotifyDialogOpen(false)
    if (!choice) return
    if (choice.kind === "assign") {
      void performAssign(choice.partnerMemberId, notify)
    } else {
      void performRemove(choice.linkId, notify)
    }
  }

  const pending = [...(state?.pendingIncoming ?? []), ...(state?.pendingOutgoing ?? [])]

  function renderLinkRow(link: SerializedPartnerLinkView, confirmed: boolean) {
    return (
      <div
        key={link.id}
        className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-foreground">
              {link.partner.firstName} {link.partner.lastName}
            </p>
            {confirmed ? (
              <Badge className="border-success/20 bg-success-muted text-success">
                Confirmed
              </Badge>
            ) : (
              <Badge variant="secondary" className="border-warning/20 bg-warning-muted text-warning">
                Pending consent
              </Badge>
            )}
            {link.assignedByAdmin && <Badge variant="secondary">Admin assigned</Badge>}
            {!link.partner.canLogin && (
              <Badge variant="secondary" className="border-info/20 bg-info-muted text-info">
                Non-Login
              </Badge>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              router.push(
                buildHrefWithReturnTo(`${adminHref("member-detail", { id: link.partner.id })}`, currentMemberPath)
              )
            }
          >
            View Partner
          </Button>
          {!memberIsArchived && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={!ancestorRendersViewOnlyBanner}
              variant="outline"
              size="sm"
              onClick={() => handleRemove(link.id, confirmed)}
              disabled={removingId === link.id}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              {removingId === link.id ? "Removing..." : "Remove"}
            </ViewOnlyActionButton>
          )}
        </div>
      </div>
    )
  }

  return (
    <Card className={className}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base font-medium">Partner</CardTitle>
        {memberIsArchived ? (
          <Badge variant="secondary" className="border-border bg-muted text-foreground">
            Archived
          </Badge>
        ) : !state?.confirmed && isAdultMember ? (
          <ViewOnlyActionButton canEdit={canEdit} describeReason={!ancestorRendersViewOnlyBanner} variant="outline" size="sm" onClick={() => setAssignOpen((open) => !open)}>
            <HeartHandshake className="h-4 w-4 mr-1" />
            Assign Partner
          </ViewOnlyActionButton>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {(error || searchError) && (
            <div className="rounded border border-danger/20 bg-danger-muted p-2 text-sm text-danger">
              {error || searchError}
            </div>
          )}

          {state?.confirmed && renderLinkRow(state.confirmed, true)}
          {pending.map((link) => renderLinkRow(link, false))}

          {state && !state.confirmed && pending.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {isAdultMember
                ? "No partner recorded."
                : "Partner relationships are for adult members only."}
            </p>
          )}

          {assignOpen && !memberIsArchived && (
            <div className="space-y-2 rounded-md border bg-muted p-3">
              <Label htmlFor="partner-link-search">Partner search</Label>
              <Input
                id="partner-link-search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setError("")
                }}
                placeholder="Search by name or email"
              />
              {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
              {search.trim().length >= 2 && searchResults.length > 0 ? (
                <div className="space-y-1">
                  {searchResults.map((candidate) => (
                    <div
                      key={candidate.id}
                      className="flex flex-col gap-2 rounded border bg-card p-2 text-card-foreground sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {candidate.firstName} {candidate.lastName}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">{candidate.email}</p>
                      </div>
                      <ViewOnlyActionButton
                        canEdit={canEdit}
                        describeReason={!ancestorRendersViewOnlyBanner}
                        size="sm"
                        className="w-full sm:w-auto"
                        disabled={saving}
                        onClick={() =>
                          openNotifyChoice({
                            kind: "assign",
                            partnerMemberId: candidate.id,
                          })
                        }
                      >
                        {saving ? "Assigning..." : "Assign"}
                      </ViewOnlyActionButton>
                    </div>
                  ))}
                </div>
              ) : search.trim().length >= 2 && !searching ? (
                <p className="text-sm text-muted-foreground">No eligible adult members found.</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Start typing at least 2 characters to search. Assigning records the
                  partnership immediately, without a consent round-trip.
                </p>
              )}
            </div>
          )}
        </div>
      </CardContent>

      {/* #1769a: per-action member-email choice, mirroring the #1695/#1705
          pattern. Shown only when an email would otherwise be sent (assign
          always; remove only for a CONFIRMED link). Both choices complete the
          action; the choice itself is recorded in the audit log. */}
      <Dialog
        open={notifyDialogOpen}
        onOpenChange={(open) => {
          if (!open && !saving && removingId === null) setNotifyDialogOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {notifyChoice?.kind === "remove"
                ? "Email the members about this removal?"
                : "Email the members about this partnership?"}
            </DialogTitle>
            <DialogDescription>
              {notifyChoice?.kind === "remove"
                ? "The partnership is removed either way. Choose whether the members receive the standard partner-relationship removal email — your choice is recorded in the audit log."
                : "The partnership is recorded either way. Choose whether the members receive the standard partner-relationship email — your choice is recorded in the audit log."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={saving || removingId !== null}
              onClick={() => confirmNotify(false)}
            >
              {notifyChoice?.kind === "remove"
                ? "Remove without emailing"
                : "Assign without emailing"}
            </Button>
            <Button
              disabled={saving || removingId !== null}
              onClick={() => confirmNotify(true)}
            >
              {notifyChoice?.kind === "remove"
                ? "Remove and email members"
                : "Assign and email members"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
