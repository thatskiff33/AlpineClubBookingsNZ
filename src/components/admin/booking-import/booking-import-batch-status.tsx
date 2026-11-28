"use client"

import type { BookingImportBatchStatus } from "@prisma/client"

import { Badge } from "@/components/ui/badge"

const LABELS: Record<BookingImportBatchStatus, string> = {
  OPEN: "Not finished",
  COMPLETED: "Imported",
  REVERSED: "Reversed",
}

/** A batch's status in plain words (#5005). */
export function BookingImportBatchStatusBadge({ status }: { status: BookingImportBatchStatus }) {
  return <Badge variant={status === "COMPLETED" ? "outline" : "secondary"}>{LABELS[status]}</Badge>
}
