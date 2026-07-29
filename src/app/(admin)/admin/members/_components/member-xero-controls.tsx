"use client"

import { ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card"
import type { UseXeroEntranceFeeDecisionResult } from "@/lib/admin-xero-entrance-fee"
import { buildXeroContactUrl } from "@/lib/xero-links"
import type { Member, MemberForm, XeroChoice } from "../_types"
import { getBlankOptionalXeroFields, getMissingFieldsForXeroCreate } from "../_utils"
import { MemberXeroEntranceFeeFields } from "./member-xero-entrance-fee-fields"

interface MemberXeroControlsProps {
  editingMember: Member | null
  form: MemberForm
  xeroConnected: boolean | null
  /**
   * Organisation short code for the "View in Xero" deep link, or null when
   * unavailable — the link then degrades to the generic session-scoped Xero
   * URL, it is never hidden (#2283).
   */
  xeroOrgShortCode: string | null
  xeroChoice: XeroChoice
  xeroUnlinking: boolean
  xeroSearchQuery: string
  xeroSearchResults: XeroSearchResult[]
  xeroSearchLoading: boolean
  selectedXeroContactId: string
  entranceFeeDecision: UseXeroEntranceFeeDecisionResult
  onChangeXeroChoice: (value: XeroChoice) => void
  onChangeXeroSearchQuery: (value: string) => void
  onChangeSelectedXeroContactId: (value: string) => void
  onXeroSearch: () => void
  onXeroLink: (memberId: string, contactId: string) => void
  onXeroUnlink: (memberId: string) => void
  onXeroPush: (memberId: string, memberName: string) => void
  onClearFormError: () => void
}

function XeroContactSearchControls({
  xeroSearchQuery,
  xeroSearchResults,
  xeroSearchLoading,
  selectedXeroContactId,
  placeholder,
  helper,
  onChangeXeroSearchQuery,
  onChangeSelectedXeroContactId,
  onXeroSearch,
}: {
  xeroSearchQuery: string
  xeroSearchResults: XeroSearchResult[]
  xeroSearchLoading: boolean
  selectedXeroContactId: string
  placeholder: string
  helper?: string
  onChangeXeroSearchQuery: (value: string) => void
  onChangeSelectedXeroContactId: (value: string) => void
  onXeroSearch: () => void
}) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="Search Xero by name or email"
          value={xeroSearchQuery}
          onChange={(event) => onChangeXeroSearchQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onXeroSearch()
          }}
        />
        <Button type="button" variant="outline" onClick={onXeroSearch} disabled={xeroSearchLoading}>
          {xeroSearchLoading ? "Searching..." : "Search"}
        </Button>
      </div>
      {(xeroSearchResults.length > 0 || helper) && (
        <div className="space-y-2">
          <Label>Available Xero contacts</Label>
          <Select
            value={selectedXeroContactId || undefined}
            onValueChange={onChangeSelectedXeroContactId}
          >
            <SelectTrigger>
              <SelectValue placeholder={xeroSearchResults.length > 0 ? "Select a Xero contact" : placeholder} />
            </SelectTrigger>
            <SelectContent>
              {xeroSearchResults.map((contact) => (
                <SelectItem key={contact.contactId} value={contact.contactId}>
                  {contact.name}
                  {contact.email ? ` (${contact.email})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
        </div>
      )}
    </div>
  )
}

export function MemberXeroControls({
  editingMember,
  form,
  xeroConnected,
  xeroOrgShortCode,
  xeroChoice,
  xeroUnlinking,
  xeroSearchQuery,
  xeroSearchResults,
  xeroSearchLoading,
  selectedXeroContactId,
  entranceFeeDecision,
  onChangeXeroChoice,
  onChangeXeroSearchQuery,
  onChangeSelectedXeroContactId,
  onXeroSearch,
  onXeroLink,
  onXeroUnlink,
  onXeroPush,
  onClearFormError,
}: MemberXeroControlsProps) {
  if (!editingMember && xeroConnected === false) {
    return (
      <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
        Xero is not connected right now. This member will be created locally only.
      </div>
    )
  }

  if (!editingMember && xeroConnected === null) {
    return (
      <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
        Checking Xero connection status...
      </div>
    )
  }

  if (xeroConnected !== true) return null

  const missingFields = getMissingFieldsForXeroCreate(form)
  const blankOptionalFields = getBlankOptionalXeroFields(form)

  return (
    <fieldset className="space-y-3 pt-2 border-t">
      <legend className="text-sm font-medium">Xero</legend>

      {editingMember && editingMember.xeroContactId && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="bg-info-3 text-info-11 border-info-6">
                Linked
              </Badge>
              <a
                href={buildXeroContactUrl(editingMember.xeroContactId, {
                  shortCode: xeroOrgShortCode,
                })}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-info-11 hover:underline inline-flex items-center gap-1"
              >
                View in Xero <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onChangeXeroChoice(xeroChoice === "change" ? "" : "change")}
              >
                {xeroChoice === "change" ? "Cancel Change" : "Change Contact"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onXeroUnlink(editingMember.id)}
                disabled={xeroUnlinking}
              >
                {xeroUnlinking ? "Unlinking..." : "Unlink"}
              </Button>
            </div>
          </div>
          {editingMember.xeroContactGroups.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {editingMember.xeroContactGroups.map((group) => (
                <Badge
                  key={group.id}
                  variant="secondary"
                  className="bg-success-3 text-success-11 border-success-6"
                >
                  {group.name}
                </Badge>
              ))}
            </div>
          )}
          {!editingMember.xeroContactGroupsLoaded && (
            <p className="text-xs text-muted-foreground">
              Cached contact groups have not been refreshed yet.
            </p>
          )}
          {xeroChoice === "change" && (
            <div className="space-y-3 rounded-md border border-info-6 bg-info-3 p-3">
              <p className="text-sm text-info-11">
                Search for a different Xero contact to link to this member. The current link
                will be replaced.
              </p>
              <XeroContactSearchControls
                xeroSearchQuery={xeroSearchQuery}
                xeroSearchResults={xeroSearchResults}
                xeroSearchLoading={xeroSearchLoading}
                selectedXeroContactId={selectedXeroContactId}
                placeholder="Select a Xero contact"
                onChangeXeroSearchQuery={onChangeXeroSearchQuery}
                onChangeSelectedXeroContactId={onChangeSelectedXeroContactId}
                onXeroSearch={onXeroSearch}
              />
              {selectedXeroContactId && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onXeroLink(editingMember.id, selectedXeroContactId)}
                >
                  Link to Selected Contact
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {editingMember && !editingMember.xeroContactId && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">This member is not linked to a Xero contact.</p>
          <Select value={xeroChoice || undefined} onValueChange={(value) => onChangeXeroChoice(value as "link" | "create")}>
            <SelectTrigger>
              <SelectValue placeholder="Link or create a Xero contact..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="link">Link an existing Xero contact</SelectItem>
              <SelectItem value="create">Create a new Xero contact</SelectItem>
            </SelectContent>
          </Select>

          {xeroChoice === "link" && (
            <div className="space-y-3">
              <XeroContactSearchControls
                xeroSearchQuery={xeroSearchQuery}
                xeroSearchResults={xeroSearchResults}
                xeroSearchLoading={xeroSearchLoading}
                selectedXeroContactId={selectedXeroContactId}
                placeholder="Select a Xero contact"
                helper="Only unlinked Xero contacts are shown."
                onChangeXeroSearchQuery={onChangeXeroSearchQuery}
                onChangeSelectedXeroContactId={onChangeSelectedXeroContactId}
                onXeroSearch={onXeroSearch}
              />
              {selectedXeroContactId && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onXeroLink(editingMember.id, selectedXeroContactId)}
                >
                  Link to Selected Contact
                </Button>
              )}
            </div>
          )}

          {xeroChoice === "create" && (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
                Creating a new Xero contact needs only a first name, last name, and email.
                Save changes first, then create. We&apos;ll check for similar Xero contacts
                before a brand-new contact is created.
              </div>
              {blankOptionalFields.length > 0 && (
                <div className="rounded-md border border-info-6 bg-info-3 p-3 text-sm text-info-11">
                  Profile incomplete: {blankOptionalFields.join(", ")} — missing details will
                  simply be left off the Xero contact.
                </div>
              )}
              <MemberXeroEntranceFeeFields
                idPrefix="edit-xero"
                decision={entranceFeeDecision}
                onClearError={onClearFormError}
                memberId={editingMember.id}
              />
              <Button
                type="button"
                size="sm"
                onClick={() => onXeroPush(editingMember.id, `${editingMember.firstName} ${editingMember.lastName}`)}
                disabled={missingFields.length > 0}
              >
                Create Xero Contact
              </Button>
              {missingFields.length > 0 && (
                <p className="text-xs text-danger-11">
                  Complete these fields first: {missingFields.join(", ")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {!editingMember && (
        <>
          <div className="space-y-2">
            <Label>After creating this member</Label>
            <Select
              value={xeroChoice || undefined}
              onValueChange={(value) => onChangeXeroChoice(value as "link" | "create")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Choose whether to link or create a Xero contact" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="link">Link an existing Xero contact</SelectItem>
                <SelectItem value="create">Create a new Xero contact</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {xeroChoice === "link" && (
            <XeroContactSearchControls
              xeroSearchQuery={xeroSearchQuery}
              xeroSearchResults={xeroSearchResults}
              xeroSearchLoading={xeroSearchLoading}
              selectedXeroContactId={selectedXeroContactId}
              placeholder="Search to load unlinked Xero contacts"
              helper="Only unlinked Xero contacts are shown here. If none match, switch to Create."
              onChangeXeroSearchQuery={onChangeXeroSearchQuery}
              onChangeSelectedXeroContactId={onChangeSelectedXeroContactId}
              onXeroSearch={onXeroSearch}
            />
          )}

          {xeroChoice === "create" && (
            <div className="space-y-3 rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
              <p>
                Creating a new Xero contact needs only a first name, last name, and email.
                We&apos;ll check for similar Xero contacts before a brand-new contact is
                created.
              </p>
              {blankOptionalFields.length > 0 && (
                <p className="rounded-md border border-info-6 bg-info-3 p-2 text-info-11">
                  Profile incomplete: {blankOptionalFields.join(", ")} — missing details will
                  simply be left off the Xero contact.
                </p>
              )}
              <div className="text-foreground">
                <MemberXeroEntranceFeeFields
                  idPrefix="create-xero"
                  decision={entranceFeeDecision}
                  onClearError={onClearFormError}
                />
              </div>
            </div>
          )}
        </>
      )}
    </fieldset>
  )
}
