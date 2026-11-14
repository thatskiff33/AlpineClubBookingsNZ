"use client"

import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BulkAction } from "../_types"

interface MemberBulkActionBarProps {
  selectedCount: number
  selectedPasswordActionCount: number
  bulkPasswordActionLabel: string
  onOpenBulkDialog: (action: BulkAction) => void
  onOpenPasswordActionDialog: () => void
  onClearSelection: () => void
}

export function MemberBulkActionBar({
  selectedCount,
  selectedPasswordActionCount,
  bulkPasswordActionLabel,
  onOpenBulkDialog,
  onOpenPasswordActionDialog,
  onClearSelection,
}: MemberBulkActionBarProps) {
  if (selectedCount === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-info/30 bg-info-muted p-3 text-info">
      <span className="text-sm font-medium">{selectedCount} selected</span>
      <Button size="sm" variant="outline" onClick={() => onOpenBulkDialog("deactivate")}>
        Deactivate
      </Button>
      <Button size="sm" variant="outline" onClick={() => onOpenBulkDialog("reactivate")}>
        Reactivate
      </Button>
      <Button size="sm" variant="outline" onClick={() => onOpenBulkDialog("set-role")}>
        Change Access
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onOpenBulkDialog("set-membership-type")}
      >
        Set Membership Type
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={selectedPasswordActionCount === 0}
        onClick={onOpenPasswordActionDialog}
      >
        {bulkPasswordActionLabel}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClearSelection}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  )
}
