"use client"
import { fetchWithRecentAuth } from "@/components/confirm-its-you"

import { useEffect, useState } from "react"
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
import { useAccessRoleOptions } from "@/hooks/use-access-role-options"
import type { BulkAction } from "../_types"

// What each action really does on the server (#4973). Keep these sentences
// aligned with api/admin/members/bulk-update/route.ts: a change to that route's
// side effects changes this map in the same PR.
const actionDescriptions: Record<BulkAction, string> = {
  deactivate: "Each member's leaving date will be set to today. Their future shared-room bed placements will be cleared and are not restored by Reactivate.",
  reactivate: "Each member's leaving date will be cleared.",
  "set-role": "Each member's existing access roles will be replaced by the chosen role.",
}

const MAX_LISTED_MEMBERS = 10

interface MemberBulkDialogProps {
  open: boolean
  action: BulkAction
  selectedIds: Set<string>
  /** Display names of the selected members the page has loaded, in table order. */
  selectedMembers: ReadonlyArray<{ id: string; name: string }>
  onOpenChange: (open: boolean) => void
  onUpdated: (updated: number) => void
  onError: (message: string) => void
}

export function MemberBulkDialog({
  open,
  action,
  selectedIds,
  selectedMembers,
  onOpenChange,
  onUpdated,
  onError,
}: MemberBulkDialogProps) {
  const roleOptions = useAccessRoleOptions()
  const [bulkRole, setBulkRole] = useState<string>("USER")
  const [bulkLoading, setBulkLoading] = useState(false)

  useEffect(() => {
    if (open) setBulkRole("USER")
  }, [open])

  const handleBulkAction = async () => {
    setBulkLoading(true)
    try {
      const body: Record<string, unknown> = { ids: [...selectedIds], action }
      if (action === "set-role") body.accessRoles = [bulkRole]
      const res = await fetchWithRecentAuth("/api/admin/members/bulk-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { updated?: number; error?: string }
      if (!res.ok) throw new Error(data.error || "Bulk update failed")
      onUpdated(data.updated ?? 0)
      onOpenChange(false)
    } catch (err) {
      onError(err instanceof Error ? err.message : "Bulk update failed")
    } finally {
      setBulkLoading(false)
    }
  }

  const listedMembers = selectedMembers.slice(0, MAX_LISTED_MEMBERS)
  // Counted from the ids actually posted, so a selection the page has no name
  // for is still owned up to rather than silently left off the list.
  const unlistedCount = selectedIds.size - listedMembers.length

  const titleAction =
    action === "set-role" ? "Change Access" : action === "deactivate" ? "Deactivate" : "Reactivate"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk {titleAction}</DialogTitle>
          <DialogDescription>
            This will affect {selectedIds.size} selected member(s). {actionDescriptions[action]}
          </DialogDescription>
        </DialogHeader>
        <ul aria-label="Selected members" className="text-sm list-disc pl-5">
          {listedMembers.map((member) => (
            <li key={member.id}>{member.name}</li>
          ))}
          {unlistedCount > 0 && <li>and {unlistedCount} more</li>}
        </ul>
        {action === "set-role" && (
          <div className="space-y-2">
            <Label htmlFor="member-bulk-role">New Access Role</Label>
            <Select value={bulkRole} onValueChange={setBulkRole}>
              <SelectTrigger id="member-bulk-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.token} value={option.token}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={bulkLoading}>
            Cancel
          </Button>
          <Button
            onClick={handleBulkAction}
            disabled={bulkLoading}
            variant={action === "deactivate" ? "destructive" : "default"}
          >
            {bulkLoading ? "Processing..." : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
