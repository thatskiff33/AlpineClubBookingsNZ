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
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadInstantDate } from "../../../_lib/payload-instant"
import { buildXeroInvoiceUrl } from "@/lib/xero-links"
import { seasonSelectLabel } from "@/lib/season-label"
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
  // `paidAt` is a real INSTANT — the moment the subscription was settled — read
  // in the club's persisted zone (`INV-CONFIG-002`), not the admin's browser.
  const clubTime = useClubTime()
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
              {seasonSelectLabel(sub.seasonYear)}
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
              {sub.paidAt ? formatPayloadInstantDate(clubTime, sub.paidAt) : "-"}
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
