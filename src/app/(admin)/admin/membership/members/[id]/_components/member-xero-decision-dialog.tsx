"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  XeroSuggestedContactCard,
  type XeroSearchResult,
} from "@/components/admin/xero-suggested-contact-card"
import { FocusedActionError } from "@/components/focused-action-error"
import type { MemberDetail } from "../_types"

interface MemberXeroDecisionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: MemberDetail
  results: XeroSearchResult[]
  selectedContactId: string
  createEntranceFeeInvoice: boolean
  linking: boolean
  pushing: boolean
  error: string
  onSelectContact: (contactId: string) => void
  onConfirmLink: () => void
  onCreateAnyway: () => void
}

export function MemberXeroDecisionDialog({
  open,
  onOpenChange,
  member,
  results,
  selectedContactId,
  createEntranceFeeInvoice,
  linking,
  pushing,
  error,
  onSelectContact,
  onConfirmLink,
  onCreateAnyway,
}: MemberXeroDecisionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review Similar Xero Contacts</DialogTitle>
          <DialogDescription>
            We found existing Xero contacts that may already belong to {member.firstName} {member.lastName}. Link one
            of these if appropriate, or create a new contact anyway.
          </DialogDescription>
        </DialogHeader>
        <FocusedActionError id="member-xero-decision-error" error={error} />
        <div className="space-y-3">
          <div className="max-h-[360px] overflow-y-auto space-y-2">
            {results.map((contact) => (
              <XeroSuggestedContactCard
                key={contact.contactId}
                contact={contact}
                radioName="member-detail-potential-xero-contact"
                checked={selectedContactId === contact.contactId}
                onSelect={() => onSelectContact(contact.contactId)}
              />
            ))}
          </div>
          {createEntranceFeeInvoice && (
            <div className="rounded-md border border-warning-6 bg-warning-3 p-3 text-sm text-warning-11">
              If you choose <span className="font-medium">Create New Contact Anyway</span>, the membership joining fee
              invoice will also be queued.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={linking || pushing}>
            Do This Later
          </Button>
          <Button variant="outline" onClick={onConfirmLink} disabled={linking || pushing || !selectedContactId}>
            {linking ? "Linking..." : "Link Selected Contact"}
          </Button>
          <Button onClick={onCreateAnyway} disabled={linking || pushing}>
            {pushing ? "Creating..." : "Create New Contact Anyway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
