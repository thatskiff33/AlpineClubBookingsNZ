"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeletionRequestMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  active: boolean;
}

interface DeletionRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  member: DeletionRequestMember;
}

interface ApiResponse {
  requests: DeletionRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function DeletionRequestsPage() {
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reviewDialog, setReviewDialog] = useState<{
    request: DeletionRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(`/api/admin/deletion-requests?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load deletion requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function handleReview() {
    if (!reviewDialog) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/deletion-requests/${reviewDialog.request.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: reviewDialog.action,
            note: reviewNote || undefined,
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed");
      setReviewDialog(null);
      setReviewNote("");
      fetchRequests();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to process request");
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = (status: string) => {
    if (status === "PENDING")
      return (
        <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
          Pending
        </Badge>
      );
    if (status === "APPROVED")
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200">
          Approved
        </Badge>
      );
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200">Rejected</Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Deletion Requests</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review and process member account deletion requests
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Requests</CardTitle>
              <CardDescription>
                {data ? `${data.total} total` : "Loading..."}
              </CardDescription>
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading && (
            <p className="text-sm text-slate-500 py-4">Loading...</p>
          )}
          {error && (
            <p className="text-sm text-red-600 py-4">{error}</p>
          )}
          {!loading && data && data.requests.length === 0 && (
            <p className="text-sm text-slate-500 py-4">
              No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
              deletion requests.
            </p>
          )}
          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((req) => (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900">
                          {req.member.firstName} {req.member.lastName}
                        </span>
                        <span className="text-sm text-slate-500">
                          {req.member.email}
                        </span>
                        {statusBadge(req.status)}
                      </div>
                      <p className="text-xs text-slate-400">
                        Requested{" "}
                        {new Date(req.createdAt).toLocaleDateString("en-NZ", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.adminNote && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Admin note:</span>{" "}
                          {req.adminNote}
                        </p>
                      )}
                      {req.reviewedAt && (
                        <p className="text-xs text-slate-400">
                          Reviewed{" "}
                          {new Date(req.reviewedAt).toLocaleDateString("en-NZ", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </p>
                      )}
                    </div>
                    {req.status === "PENDING" && (
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "reject" })
                          }
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "approve" })
                          }
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-slate-500">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Review Dialog */}
      <Dialog
        open={!!reviewDialog}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog(null);
            setReviewNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === "approve"
                ? "Approve Deletion Request"
                : "Reject Deletion Request"}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === "approve" ? (
                <>
                  This will permanently anonymise{" "}
                  <strong>
                    {reviewDialog.request.member.firstName}{" "}
                    {reviewDialog.request.member.lastName}
                  </strong>
                  &apos;s account, cancel all future bookings, and deactivate
                  their login. This action cannot be undone.
                </>
              ) : (
                <>
                  The member will be notified that their request was not
                  approved.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="review-note">
              {reviewDialog?.action === "approve"
                ? "Note (optional)"
                : "Reason for rejection (optional — will be sent to member)"}
            </Label>
            <Textarea
              id="review-note"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder={
                reviewDialog?.action === "reject"
                  ? "E.g. Outstanding bookings must be resolved first"
                  : "Internal note"
              }
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReviewDialog(null);
                setReviewNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant={
                reviewDialog?.action === "approve" ? "destructive" : "default"
              }
              onClick={handleReview}
              disabled={submitting}
            >
              {submitting
                ? "Processing..."
                : reviewDialog?.action === "approve"
                ? "Approve & Delete Account"
                : "Reject Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
