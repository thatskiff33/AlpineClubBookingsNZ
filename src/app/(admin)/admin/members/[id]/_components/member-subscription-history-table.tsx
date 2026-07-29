"use client"

import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ExternalLink } from "lucide-react"
import {
  subscriptionStatusClass,
  subscriptionStatusLabel,
} from "@/lib/status-colors"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import { buildXeroInvoiceUrl } from "@/lib/xero-links"
import type { MemberDetail } from "../_types"

export function MemberSubscriptionHistoryTable({
  subscriptions,
  xeroOrgShortCode,
}: {
  subscriptions: MemberDetail["subscriptions"]
  /**
   * Organisation short code for the invoice deep links, or null when
   * unavailable — the links then degrade to the generic session-scoped Xero
   * URL, they are never hidden (#2283).
   */
  xeroOrgShortCode: string | null
}) {
  if (subscriptions.length === 0) {
    return <p className="text-sm text-muted-foreground">No subscription records</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Season Year</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Paid At</TableHead>
          <TableHead>Xero Invoice</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {subscriptions.map((sub) => (
          <TableRow key={sub.id}>
            <TableCell className="font-medium">
              {sub.seasonYear}/{sub.seasonYear + 1}
            </TableCell>
            <TableCell>
              <Badge
                variant="secondary"
                className={subscriptionStatusClass(sub.status)}
              >
                {subscriptionStatusLabel(sub.status)}
              </Badge>
            </TableCell>
            <TableCell>
              {sub.paidAt ? formatMemberDateNz(sub.paidAt) : "-"}
            </TableCell>
            <TableCell>
              {sub.xeroInvoiceId ? (
                <a
                  href={buildXeroInvoiceUrl(sub.xeroInvoiceId, {
                    shortCode: xeroOrgShortCode,
                  })}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-info-11 hover:underline inline-flex items-center gap-1"
                >
                  View <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                "-"
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
