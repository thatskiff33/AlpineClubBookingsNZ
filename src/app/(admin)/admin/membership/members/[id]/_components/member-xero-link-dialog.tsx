"use client"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { FocusedActionError } from "@/components/focused-action-error"
import { Search } from "lucide-react"
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card"
import type { MemberDetail } from "../_types"

interface MemberXeroLinkDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  member: MemberDetail
  query: string
  results: XeroSearchResult[]
  searching: boolean
  linking: boolean
  error: string
  onChangeQuery: (value: string) => void
  onClearError: () => void
  onSearch: () => void
  onLink: (xeroContactId: string) => void
}

export function MemberXeroLinkDialog({
  open,
  onOpenChange,
  member,
  query,
  results,
  searching,
  linking,
  error,
  onChangeQuery,
  onClearError,
  onSearch,
  onLink,
}: MemberXeroLinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {member.xeroContactId ? "Change Xero Contact Link" : "Link to Xero Contact"}
          </DialogTitle>
          <DialogDescription>
            {member.xeroContactId
              ? `Search for a different Xero contact to relink ${member.firstName} ${member.lastName}.`
              : `Search for an existing Xero contact to link to ${member.firstName} ${member.lastName}.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="Search by name or email..."
            value={query}
            onChange={(e) => {
              onChangeQuery(e.target.value)
              if (error) onClearError()
            }}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
          />
          <Button onClick={onSearch} disabled={searching || query.length < 2}>
            <Search className="h-4 w-4 mr-1" />
            {searching ? "..." : "Search"}
          </Button>
        </div>
        <FocusedActionError id="member-xero-link-error" error={error} />
        <div className="max-h-64 overflow-y-auto space-y-2">
          {results.length === 0 && !searching && query.length >= 2 && (
            <p className="py-4 text-center text-sm text-muted-foreground">No contacts found</p>
          )}
          {results.map((c) => (
            <div key={c.contactId} className="flex flex-col gap-2 rounded border p-2 hover:bg-muted sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">{c.name}</p>
                {c.email && <p className="break-all text-xs text-muted-foreground">{c.email}</p>}
                {c.isLinked && (
                  <p className="text-xs text-warning">Already linked to {c.linkedMemberName}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={c.isLinked || linking}
                onClick={() => onLink(c.contactId)}
              >
                {linking ? "..." : "Link"}
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
