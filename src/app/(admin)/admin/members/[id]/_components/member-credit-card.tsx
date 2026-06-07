"use client"

import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  formatAdminName,
  formatMemberDateNz,
} from "@/lib/admin-member-detail-helpers"
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
}: MemberCreditCardProps) {
  const { data: session } = useSession()
  const currentAdminId = session?.user?.id

  return (
    <Card id="account-credit">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base font-medium">Account Credit</CardTitle>
        <div className="flex items-center gap-3">
          <span
            className={`text-lg font-semibold ${
              creditBalance > 0 ? "text-green-700" : creditBalance < 0 ? "text-red-700" : "text-slate-700"
            }`}
          >{`$${(creditBalance / 100).toFixed(2)}`}</span>
          <Button size="sm" variant="outline" onClick={onToggleAdjustmentForm}>
            {showAdjustmentForm ? "Cancel" : "Request Adjustment"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {adjustmentError && (
          <div className="mb-4 p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">{adjustmentError}</div>
        )}
        {showAdjustmentForm && (
          <div className="mb-4 p-4 border border-slate-200 rounded-md bg-slate-50 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="adj-amount">Amount ($)</Label>
                <Input
                  id="adj-amount"
                  type="number"
                  step="0.01"
                  placeholder="e.g. 25.00 or -10.00"
                  value={adjustmentAmount}
                  onChange={(e) => onChangeAdjustmentAmount(e.target.value)}
                />
                <p className="text-xs text-slate-500">Positive = add credit, negative = deduct</p>
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
            <p className="text-xs text-slate-500">
              A different admin must approve this request before the member&apos;s credit balance changes.
            </p>
            <Button size="sm" onClick={onSubmitAdjustment} disabled={adjustmentSaving}>
              {adjustmentSaving ? "Saving..." : "Submit for Approval"}
            </Button>
          </div>
        )}
        {creditLoading ? (
          <p className="text-sm text-slate-500">Loading credit history...</p>
        ) : creditError ? (
          <p className="text-sm text-red-600">{creditError}</p>
        ) : (
          <>
            {pendingAdjustmentRequests.length > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4">
                <div className="mb-3">
                  <p className="text-sm font-medium text-amber-900">Pending manual adjustments</p>
                  <p className="text-xs text-amber-800">
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
                          <TableCell className="text-sm">{formatMemberDateNz(item.createdAt)}</TableCell>
                          <TableCell
                            className={`font-medium ${
                              item.amountCents > 0 ? "text-green-700" : "text-red-700"
                            }`}
                          >{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
                          <TableCell className="text-sm text-slate-600 max-w-[260px] truncate">{item.description}</TableCell>
                          <TableCell className="text-sm">{formatAdminName(item.requestedBy)}</TableCell>
                          <TableCell className="text-right">
                            {isOwnRequest ? (
                              <span className="text-xs text-amber-700">Needs another admin</span>
                            ) : (
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={isReviewing}
                                  onClick={() => onReviewAdjustment(item.id, "APPROVE")}
                                >
                                  {isReviewing ? "Working..." : "Approve"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={isReviewing}
                                  onClick={() => onReviewAdjustment(item.id, "REJECT")}
                                >
                                  Reject
                                </Button>
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
              <p className="text-sm text-slate-500">No credit transactions</p>
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
                      <TableCell className="text-sm">{formatMemberDateNz(item.createdAt)}</TableCell>
                      <TableCell>
                        <Badge
                          variant="secondary"
                          className={
                            item.type === "CANCELLATION_REFUND" || item.type === "BOOKING_MODIFICATION_REFUND"
                              ? "bg-orange-100 text-orange-800 border-orange-200"
                              : item.type === "ADMIN_ADJUSTMENT"
                                ? "bg-blue-100 text-blue-800 border-blue-200"
                                : "bg-purple-100 text-purple-800 border-purple-200"
                          }
                        >
                          {item.type === "BOOKING_MODIFICATION_REFUND"
                            ? "BOOKING CHANGE CREDIT"
                            : item.type.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className={`font-medium ${item.amountCents > 0 ? "text-green-700" : "text-red-700"}`}
                      >{`${item.amountCents > 0 ? "+" : ""}$${(item.amountCents / 100).toFixed(2)}`}</TableCell>
                      <TableCell className="text-sm text-slate-600 max-w-[200px] truncate">{item.description}</TableCell>
                      <TableCell className="text-xs text-slate-600">
                        {item.type === "ADMIN_ADJUSTMENT" && (item.requestedBy || item.approvedBy) ? (
                          <div className="space-y-1">
                            {item.requestedBy && <p>Requested by {formatAdminName(item.requestedBy)}</p>}
                            {item.approvedBy && (
                              <p>
                                Approved by {formatAdminName(item.approvedBy)}
                                {item.approvalRequest?.reviewedAt
                                  ? ` on ${formatMemberDateNz(item.approvalRequest.reviewedAt)}`
                                  : ""}
                              </p>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {item.sourceBooking ? (
                          <span className="text-blue-600">
                            {formatMemberDateNz(item.sourceBooking.checkIn)} -{" "}
                            {formatMemberDateNz(item.sourceBooking.checkOut)}
                          </span>
                        ) : item.appliedToBooking ? (
                          <span className="text-purple-600">
                            {formatMemberDateNz(item.appliedToBooking.checkIn)} -{" "}
                            {formatMemberDateNz(item.appliedToBooking.checkOut)}
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
