"use client"

import { useId } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Search } from "lucide-react"
import {
  dedupeParentOptions,
  MEMBER_SEARCH_TRUNCATED_HINT,
  parentLinkTypeLabel,
} from "@/lib/admin-member-detail-helpers"
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import { useDependentEmailSource } from "@/hooks/use-dependent-email-source"
import { DependentNotificationRoutingNotice } from "./dependent-notices"
import type { LinkParentSearchResult, MemberDetail } from "../_types"

interface MemberParentLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: MemberDetail
  search: string
  searching: boolean
  searchResults: LinkParentSearchResult[]
  /**
   * More people matched than the page shows (#2425). Rendered as a hint under
   * the list, and announced in a polite live region (#2460); never as a count,
   * and never on a list that holds everyone.
   */
  resultsTruncated?: boolean
  selected: LinkParentSearchResult | null
  notificationParentId: string
  disableLogin: boolean
  familyGroupIds: string[]
  saving: boolean
  error: string
  onChangeSearch: (value: string) => void
  onSelectCandidate: (candidate: LinkParentSearchResult) => void
  onClearSelection: () => void
  onChangeNotificationParentId: (value: string) => void
  onChangeDisableLogin: (value: boolean) => void
  onToggleFamilyGroup: (familyGroupId: string, checked: boolean) => void
  onSubmit: () => void
}

export function MemberParentLinkDialog({
  open,
  onOpenChange,
  member,
  search,
  searching,
  searchResults,
  resultsTruncated = false,
  selected,
  notificationParentId,
  disableLogin,
  familyGroupIds,
  saving,
  error,
  onChangeSearch,
  onSelectCandidate,
  onClearSelection,
  onChangeNotificationParentId,
  onChangeDisableLogin,
  onToggleFamilyGroup,
  onSubmit,
}: MemberParentLinkDialogProps) {
  // #2282 review: where this member's club email would actually land if the
  // notifications were routed through the chosen parent. The route walks up from
  // that parent to the nearest adult who can receive mail and stores THEM, so
  // the picker's own label is not the answer. A resolution of "nobody" is the
  // 422 the write returns, so the save is refused here with the reason instead.
  const routing = useDependentEmailSource(selected ? notificationParentId : null)
  const routingNoticeId = useId()
  /**
   * Whether the pick-list is what the dialog is currently showing.
   *
   * Declared once and used BOTH as the results branch of the ternary below and
   * as the first half of the truncation gate (#2460 review). The two used to
   * state the same three conditions separately; that read as deliberate, but it
   * left the announcement free to drift away from the list it describes — raise
   * the ternary's character floor to three and the live region would have gone
   * on saying "Keep typing to narrow this down." at two, over a list that was
   * no longer being drawn at all. One expression, so they cannot disagree. The
   * `!selected` clause is redundant inside the ternary (that branch is only
   * reached when nothing is selected) and load-bearing outside it, where the
   * announcement is assembled.
   */
  const showingResultsList =
    !selected && search.trim().length >= 2 && searchResults.length > 0
  /**
   * The truncation hint's ONE gate (#2460).
   *
   * The sentence the admin reads and the sentence a screen reader hears are
   * driven from this single expression, so the two can never come to disagree
   * about whether the page was cut short — and, through `showingResultsList`,
   * neither can be said over a list that is not on screen.
   */
  const showTruncationHint = showingResultsList && resultsTruncated
  const blockedByNoEmailSource =
    routing.status === "ready" && routing.source === null
  const notificationParentName = (() => {
    if (selected && notificationParentId === selected.id) {
      return `${selected.firstName} ${selected.lastName}`
    }
    const parent = (member.parentLinks ?? []).find(
      (link) => link.id === notificationParentId,
    )
    return parent
      ? `${parent.firstName} ${parent.lastName}`
      : "the selected parent"
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link Parent</DialogTitle>
          {/* #2282: the search no longer filters on age, and neither does the
              write route, so the copy must not claim it does. A young member can
              be recorded as a parent; what stays adult-only is being the contact
              of record for the child's mail, which the dialog's own notification
              picker and the server resolve separately. "Any age" is also stated
              with its limit, so it cannot be read as covering organisation and
              school accounts — those carry no age at all and are excluded. */}
          {/* #2425: "Adults are listed first" describes the ORDER, not the
              offer — every eligible member of any age is still in the list,
              further down. Said out loud because an admin who reads the list as
              alphabetical would otherwise read an adult appearing above a child
              with the same surname as a bug. The second clause is the one the
              ranking actually guarantees (#2425 review): the split is minors
              versus everyone else, so an age-exempt member sits in the top block
              with the adults rather than among the children. */}
          <DialogDescription>
            Link {member.firstName} {member.lastName} under an active member of
            any age; adults are listed ahead of any children or youth that
            match. Organisation and school accounts are not people, so they are
            not offered. Club notifications still route to an adult.
          </DialogDescription>
        </DialogHeader>
        {error && <div className="p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm">{error}</div>}
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="link-parent-search">Parent search</Label>
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="link-parent-search"
                value={search}
                onChange={(e) => onChangeSearch(e.target.value)}
                placeholder="Search by name, email, or member ID"
                className="pl-9"
              />
              {searching && (
                <div className="absolute right-3 top-2.5 text-xs text-muted-foreground">Searching...</div>
              )}
            </div>
          </div>

          {/*
            The truncation sentence is ANNOUNCED as well as drawn (#2460).

            It used to be a bare paragraph under the list, so an admin who had
            just typed was never told the page had been cut short — under a
            screen reader the list simply stopped, which is exactly the state
            the sentence exists to explain. The member-guest finder carried the
            identical defect; both are fixed together, because this dialog's
            copy deliberately mirrors that one character for character
            (`MEMBER_SEARCH_TRUNCATED_HINT`) and a one-sided fix would break
            that claim.

            Three things about the shape are load-bearing:

            - THE WRAPPER IS MOUNTED FOR THE WHOLE LIFE OF THE OPEN DIALOG AND
              ONLY ITS CONTENT IS GATED. That is the house live-region rule
              (`AGENTS.md`: the banner "keeps its `role="status"` wrapper
              permanently mounted and gates only the content, because a polite
              live region injected already-populated is silently dropped by some
              screen-reader/browser pairings" — same for `PolicyFeedback` and
              `DependentNotice`, and the worked example is the #2244
              export-truncation notice in `promo-redemptions-panel.tsx`). The
              VISIBLE hint cannot carry the role itself: it lives inside the
              results branch of the ternary below, which mounts in a single
              commit already holding the sentence the moment a truncated search
              lands — precisely the already-populated case that gets dropped.
              Keep this element outside that ternary. The dialog does unmount
              when it closes, so the guarantee is "registered empty before the
              first search answers", which is the case this is about.
            - IT SITS ABOVE THE TERNARY, NEVER AFTER IT (#2460 review). This
              stack is `space-y-4`, and Tailwind v4 compiles that to
              `margin-block-end` on `:where(& > :not(:last-child))` — the gap is
              carried by the element BEFORE each gap, not after it. A sr-only
              region added as the last child is invisible itself but promotes
              whatever used to be last into `:not(:last-child)`, handing the
              search results a 16px bottom margin they never had and reflowing
              the dialog the moment a parent is picked. Above the ternary it is
              always a middle child, so nothing on screen moves.
            - THE ANNOUNCED WORDS ARE THE VISIBLE WORDS, VERBATIM. No count is
              added for the screen reader. The sentence is pinned equal to the
              member-guest finder's, where a count would describe members the
              booker is not being shown; announcing a different sentence here
              would fork that copy into a third string with nothing pinning it.
            - THE DRAWN PARAGRAPH IS DELIBERATELY LEFT IN THE ACCESSIBILITY TREE
              (#2460 review). The sentence is therefore reachable twice in browse
              mode: here, ahead of the list, and again as the visible hint under
              it. `aria-hidden` on the visible one would collapse that to a
              single node, and it was considered and rejected — the visible hint
              is the one anchored to the place the list stops, which is the whole
              point of the sentence, and hiding on-screen text from assistive
              technology to tidy a duplicate trades a real loss for a cosmetic
              gain. What must not happen is a second LIVE region: two regions
              carrying one sentence announce it twice and, worse, race (the repo
              grew a whole prop in `hut-leaders/_components/assignment-form.tsx`
              to stop exactly that). One region, one utterance; two static nodes,
              an entire results list apart.
          */}
          <div
            role="status"
            className="sr-only"
            data-testid="parent-link-truncation-status"
          >
            {showTruncationHint ? MEMBER_SEARCH_TRUNCATED_HINT : null}
          </div>

          {selected ? (
            <div className="rounded-md border border-border p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {selected.firstName} {selected.lastName}
                    </p>
                    <Badge variant="secondary">{selected.ageTier}</Badge>
                    {!selected.active && (
                      <Badge variant="secondary" className="bg-muted text-muted-foreground border-border">
                        Inactive
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{selected.email}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.canLogin ? "Can login" : "Non-login"}
                    {selected.dateOfBirth ? ` · DOB ${formatPayloadCalendarDay(selected.dateOfBirth)}` : ""}
                  </p>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={onClearSelection} disabled={saving}>
                  Change
                </Button>
              </div>
            </div>
          ) : showingResultsList ? (
            <div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {searchResults.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => onSelectCandidate(candidate)}
                    className="w-full border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
                  >
                    <span className="font-medium">
                      {candidate.firstName} {candidate.lastName}
                    </span>
                    <span className="ml-2 text-muted-foreground">{candidate.email}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{candidate.ageTier}</span>
                  </button>
                ))}
              </div>
              {/* #2425: only when the page really was cut short. Adults are
                  listed first, so the person being sought is normally on this
                  page — but a common surname can still overflow it, and before
                  this the list simply stopped with nothing to say it had. */}
              {showTruncationHint && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {MEMBER_SEARCH_TRUNCATED_HINT}
                </p>
              )}
            </div>
          ) : search.trim().length >= 2 && !searching ? (
            <p className="text-sm text-muted-foreground">No eligible active members found.</p>
          ) : (
            <p className="text-sm text-muted-foreground">Start typing at least 2 characters to search.</p>
          )}

          {selected && (
            <div className="space-y-4">
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="link-parent-notification-source">Notification email recipient</Label>
                  <select
                    id="link-parent-notification-source"
                    value={notificationParentId}
                    onChange={(event) => onChangeNotificationParentId(event.target.value)}
                    disabled={saving}
                    className="flex h-10 w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  >
                    <option value="">Use {member.firstName}&apos;s own email</option>
                    {dedupeParentOptions([
                      ...(member.parentLinks ?? []),
                      {
                        ...selected,
                        parentLinkType: ((member.parentLinks?.length ?? 0) === 0
                          ? "PRIMARY"
                          : "SECONDARY") as "PRIMARY" | "SECONDARY",
                      },
                    ]).map((parent) => (
                      <option key={parent.id} value={parent.id}>
                        {parent.firstName} {parent.lastName} ({parentLinkTypeLabel(parent.parentLinkType)})
                      </option>
                    ))}
                  </select>
                  {/* #2282 review: the options name PARENTS; the write resolves
                      the chosen one to the nearest adult who can actually
                      receive club mail. With parentage now recordable at any
                      age, the two differ routinely, so the resolved answer is
                      stated here rather than left to be discovered from a
                      stored pointer afterwards. */}
                  <DependentNotificationRoutingNotice
                    id={routingNoticeId}
                    state={routing}
                    selectedParentId={notificationParentId}
                    selectedParentName={notificationParentName}
                    ownEmailOptionLabel={`Use ${member.firstName}'s own email`}
                  />
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="link-parent-disable-login"
                    checked={disableLogin}
                    onCheckedChange={(checked) => onChangeDisableLogin(checked === true)}
                    disabled={saving}
                  />
                  <Label htmlFor="link-parent-disable-login" className="text-sm font-normal">
                    Disable login
                  </Label>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Add to parent family groups</Label>
                {selected.familyGroups.length > 0 ? (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    {selected.familyGroups.map((group) => (
                      <div key={group.id} className="flex items-center gap-2">
                        <Checkbox
                          id={`link-parent-family-group-${group.id}`}
                          checked={familyGroupIds.includes(group.id)}
                          onCheckedChange={(checked) => onToggleFamilyGroup(group.id, checked === true)}
                          disabled={saving}
                        />
                        <Label
                          htmlFor={`link-parent-family-group-${group.id}`}
                          className="text-sm font-normal"
                        >
                          {group.name || "Unnamed group"}
                        </Label>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">This parent is not in any family groups.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            aria-describedby={blockedByNoEmailSource ? routingNoticeId : undefined}
            disabled={saving || !selected || blockedByNoEmailSource}
          >
            {saving ? "Linking..." : "Link Parent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
