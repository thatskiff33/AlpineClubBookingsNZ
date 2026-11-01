"use client"

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

interface MemberBulkDialogProps {
  open: boolean
  action: BulkAction
  selectedIds: Set<string>
  onOpenChange: (open: boolean) => void
  onUpdated: (updated: number) => void
  onError: (message: string) => void
}

export function MemberBulkDialog({
  open,
  action,
  selectedIds,
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
      const res = await fetch("/api/admin/members/bulk-update", {
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

  const titleAction =
    action === "set-role" ? "Change Access" : action === "deactivate" ? "Deactivate" : "Reactivate"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk {titleAction}</DialogTitle>
          <DialogDescription>
            This will affect {selectedIds.size} selected member(s).
          </DialogDescription>
        </DialogHeader>
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
