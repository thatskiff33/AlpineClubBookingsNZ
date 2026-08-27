"use client"

import { useSession } from "next-auth/react"
import { ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatAdminName } from "@/lib/admin-member-detail-helpers"
import { useClubTime } from "@/components/club-time-provider"
import { formatPayloadCalendarDay } from "../../../_lib/calendar-day"
import { formatPayloadInstantDate } from "../../../_lib/payload-instant"
import type {
  CreditHistoryItem,
  PendingCreditAdjustmentItem,
} from "../_types"

interface MemberCreditCardProps {
  creditBalance: number
  creditHistory: CreditHistoryItem[]
  creditLoading: boolean
  creditError: string
  pendingAdjustmentRequests: PendingCreditAdjustmentItem[]
  reviewingAdjustmentId: string | null
  showAdjustmentForm: boolean
  adjustmentError: string
  adjustmentAmount: string
  adjustmentDescription: string
  adjustmentSaving: boolean
  onToggleAdjustmentForm: () => void
  onChangeAdjustmentAmount: (value: string) => void
  onChangeAdjustmentDescription: (value: string) => void
  onSubmitAdjustment: () => void
  onReviewAdjustment: (requestId: string, decision: "APPROVE" | "REJECT") => void
  className?: string
}

export function MemberCreditCard({
  creditBalance,
  creditHistory,
  creditLoading,
  creditError,
  pendingAdjustmentRequests,
  reviewingAdjustmentId,
  showAdjustmentForm,
  adjustmentError,
  adjustmentAmount,
  adjustmentDescription,
  adjustmentSaving,
  onToggleAdjustmentForm,
  onChangeAdjustmentAmount,
  onChangeAdjustmentDescription,
  onSubmitAdjustment,
  onReviewAdjustment,
  className,
}: MemberCreditCardProps) {
  const { data: session } = useSession()
  // Two kinds of date on this card and they are NOT interchangeable: the ledger
  // stamps (`createdAt`, `reviewedAt`) are real instants and are read in the
  // club's persisted zone, while a linked booking's `checkIn`/`checkOut` are
  // `@db.Date` lodge nights that carry no zone at all. Projecting a lodge night
  // through a zone is `INV-DATE-019` and names the night before for a club
  // behind UTC — which on a credit row is the stay the member is looking at.
  const clubTime = useClubTime()
  // #2257 — the example moved out of the placeholder and folded into the
  // sign-convention note that was already here, so ONE properly associated hint
  // describes the field instead of a grey pseudo-value plus an orphan <p>.
  const adjustmentAmountHint = useFieldHint()
  const currentAdminId = session?.user?.id
  // Credit adjustments write the finance-remapped members/[id]/credits route; a
  // view-only finance admin sees the balance but cannot request/approve (#1997).
  const canEditFinance = useAdminAreaEditAccess("finance")

  return (
    <Card id="account-credit" className={className}>
      <CardHeader className="flex flex-col gap-2 space-y-0 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base font-medium">Account Credit</CardTitle>
        <div className="flex items-center gap-3">
          <span
            className={`text-lg font-semibold ${
              creditBalance > 0 ? "text-success-11" : creditBalance < 0 ? "text-danger-11" : "text-muted-foreground"
            }`}
          >{`$${(creditBalance / 100).toFixed(2)}`}</span>
          <ViewOnlyActionButton canEdit={canEditFinance} size="sm" variant="outline" onClick={onToggleAdjustmentForm}>
            {showAdjustmentForm ? "Cancel" : "Request Adjustment"}
          </ViewOnlyActionButton>
        </div>
      </CardHeader>
      <CardContent>
        {adjustmentError && (
          // `role="alert"` (#2685 review): a refused credit-adjustment amount was
          // shown but never announced, so a screen-reader user pressing Submit
          // got silence and a form that had not saved.
          <div
            role="alert"
            className="mb-4 p-2 bg-danger-3 border border-danger-6 text-danger-11 rounded text-sm"
          >
            {adjustmentError}
          </div>
        )}
        {showAdjustmentForm && (
          <div className="mb-4 p-4 border border-border rounded-md bg-muted space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="adj-amount">Amount ($)</Label>
                <Input
                  id="adj-amount"
                  type="number"
                  step="0.01"
                  value={adjustmentAmount}
                  onChange={(e) => onChangeAdjustmentAmount(e.target.value)}
                  {...adjustmentAmountHint.fieldProps}
                />
                <FieldHint {...adjustmentAmountHint.hintProps}>
                  Positive = add credit, negative = deduct. Example: 25.00 or -10.00
                </FieldHint>
              </div>
              <div className="space-y-1">
                <Label htmlFor="adj-desc">Description *</Label>
                <Input
                  id="adj-desc"
                  placeholder="Reason for adjustment"
                  value={adjustmentDescription}
                  onChange={(e) => onChangeAdjustmentDescription(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              A different admin must approve this request before the member&apos;s credit balance changes.
            </p>
            <ViewOnlyActionButton canEdit={canEditFinance} size="sm" onClick={onSubmitAdjustment} disabled={adjustmentSaving}>
              {adjustmentSaving ? "Saving..." : "Submit for Approval"}
            </ViewOnlyActionButton>
          </div>
        )}
        {creditLoading ? (
          <p className="text-sm text-muted-foreground">Loading credit history...</p>
        ) : creditError ? (
          <p className="text-sm text-danger-11">{creditError}</p>
        ) : (
          <>
            {pendingAdjustmentRequests.length > 0 && (
              <div className="mb-4 rounded-md border border-warning-6 bg-warning-3 p-4">
                <div className="mb-3">
                  <p className="text-sm font-medium text-warning-11">Pending manual adjustments</p>
                  <p className="text-xs text-warning-11">
                    Each request needs approval from a different admin before it becomes account credit.
                  </p>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Requested</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Requested By</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendingAdjustmentRequests.map((item) => {
                      const isOwnRequest = currentAdminId === item.requestedBy.id
                      const isReviewing = reviewingAdjustmentId === item.id
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="text-sm">{formatPayloadInstantDate(clubTime, item.createdAt)}</TableCell>
                          <TableCell
                            className={`font-medium ${
                              item.amountCents > 0 ? "text-success-11" : "text-danger-11"
                            }`}
                          >{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
                          <TableCell className="text-sm text-muted-foreground max-w-[260px] truncate">{item.description}</TableCell>
                          <TableCell className="text-sm">{formatAdminName(item.requestedBy)}</TableCell>
                          <TableCell className="text-right">
                            {isOwnRequest ? (
                              <span className="text-xs text-warning-11">Needs another admin</span>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <ViewOnlyActionButton
                                  canEdit={canEditFinance}
                                  size="sm"
                                  variant="outline"
                                  disabled={isReviewing}
                                  onClick={() => onReviewAdjustment(item.id, "APPROVE")}
                                >
                                  {isReviewing ? "Working..." : "Approve"}
                                </ViewOnlyActionButton>
                                <ViewOnlyActionButton
                                  canEdit={canEditFinance}
                                  size="sm"
                                  variant="ghost"
                                  disabled={isReviewing}
                                  onClick={() => onReviewAdjustment(item.id, "REJECT")}
                                >
                                  Reject
                                </ViewOnlyActionButton>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
            {creditHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No credit transactions</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Approval</TableHead>
                    <TableHead>Booking Ref</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {creditHistory.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-sm">{formatPayloadInstantDate(clubTime, item.createdAt)}</TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            item.type === "CANCELLATION_REFUND" || item.type === "BOOKING_MODIFICATION_REFUND"
                              ? "bg-warning-3 text-warning-11 border-warning-6"
                              : item.type === "ADMIN_ADJUSTMENT"
                                ? "bg-info-3 text-info-11 border-info-6"
                                : "bg-cat1-3 text-cat1-11 border-cat1-6"
                          }
                        >
                          {item.type === "BOOKING_MODIFICATION_REFUND"
                            ? "BOOKING CHANGE CREDIT"
                            : item.type.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`font-medium ${item.amountCents > 0 ? "text-success-11" : "text-danger-11"}`}
                      >{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">{item.description}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.type === "ADMIN_ADJUSTMENT" && (item.requestedBy || item.approvedBy) ? (
                          <div className="space-y-1">
                            {item.requestedBy && <p>Requested by {formatAdminName(item.requestedBy)}</p>}
                            {item.approvedBy && (
                              <p>
                                Approved by {formatAdminName(item.approvedBy)}
                                {item.approvalRequest?.reviewedAt
                                  ? ` on ${formatPayloadInstantDate(clubTime, item.approvalRequest.reviewedAt)}`
                                  : ""}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {item.sourceBooking ? (
                          <span className="text-info-11">
                            {formatPayloadCalendarDay(item.sourceBooking.checkIn)} -{" "}
                            {formatPayloadCalendarDay(item.sourceBooking.checkOut)}
                          </span>
                        ) : item.appliedToBooking ? (
                          <span className="text-cat1-11">
                            {formatPayloadCalendarDay(item.appliedToBooking.checkIn)} -{" "}
                            {formatPayloadCalendarDay(item.appliedToBooking.checkOut)}
                          </span>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
