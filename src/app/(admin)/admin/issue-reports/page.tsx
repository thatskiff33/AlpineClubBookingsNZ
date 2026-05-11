"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Bug,
  CheckCircle2,
  ExternalLink,
  Eye,
  LoaderCircle,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type IssueReportSummary = {
  id: string;
  pageUrl: string;
  pageTitle: string | null;
  description: string;
  screenshot: {
    capturedAt: string | null;
    expiresAt: string | null;
    deletedAt: string | null;
    retained: boolean;
  };
  browserInfo: {
    expiresAt: string | null;
    deletedAt: string | null;
    retained: boolean;
  };
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
};

type IssueReportDetail = IssueReportSummary & {
  screenshot: IssueReportSummary["screenshot"] & {
    dataUrl: string | null;
    deletedById: string | null;
    deleteReason: string | null;
  };
  browserInfo: IssueReportSummary["browserInfo"] & {
    value: string | null;
  };
};

type ListResponse = {
  reports: IssueReportSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

function formatDateTime(value: string | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusBadge(report: IssueReportSummary) {
  if (report.resolvedAt) {
    return <Badge className="border-green-200 bg-green-100 text-green-800">Resolved</Badge>;
  }
  return <Badge className="border-amber-200 bg-amber-100 text-amber-800">Open</Badge>;
}

function screenshotBadge(report: IssueReportSummary) {
  if (report.screenshot.retained) {
    return <Badge className="border-sky-200 bg-sky-100 text-sky-800">Screenshot retained</Badge>;
  }
  if (report.screenshot.deletedAt) {
    return <Badge className="border-slate-200 bg-slate-100 text-slate-700">Screenshot deleted</Badge>;
  }
  return <Badge variant="outline">No screenshot</Badge>;
}

export default function AdminIssueReportsPage() {
  const searchParams = useSearchParams();
  const highlightedReportId = searchParams.get("report");
  const [statusFilter, setStatusFilter] = useState("OPEN");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse | null>(null);
  const [selectedReport, setSelectedReport] = useState<IssueReportDetail | null>(null);
  const [resolutionNote, setResolutionNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
      });
      const response = await fetch(`/api/admin/issue-reports?${params}`);
      if (!response.ok) throw new Error("Failed to load issue reports");
      setData(await response.json());
    } catch {
      setError("Failed to load issue reports.");
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  const fetchReportDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/admin/issue-reports/${id}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to load report");
      setSelectedReport(body.report);
      setResolutionNote(body.report?.resolutionNote ?? "");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load report");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  useEffect(() => {
    if (highlightedReportId) {
      fetchReportDetail(highlightedReportId);
    }
  }, [fetchReportDetail, highlightedReportId]);

  async function updateReport(action: "resolve" | "reopen" | "deleteScreenshot") {
    if (!selectedReport) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/admin/issue-reports/${selectedReport.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: action === "resolve" ? resolutionNote || undefined : undefined,
          reason: action === "deleteScreenshot" ? "Deleted during admin triage" : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Failed to update report");
      setSelectedReport(body.report);
      setResolutionNote(body.report?.resolutionNote ?? "");
      fetchReports();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update report");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Issue Reports</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review member issue reports and manage retained screenshots.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Reports</CardTitle>
              <CardDescription>{data ? `${data.total} total` : "Loading..."}</CardDescription>
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => {
                setStatusFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OPEN">Open</SelectItem>
                <SelectItem value="RESOLVED">Resolved</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              Loading reports...
            </div>
          ) : null}
          {error ? <p className="py-4 text-sm text-red-600">{error}</p> : null}
          {!loading && data?.reports.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">No issue reports found.</p>
          ) : null}
          {!loading && data && data.reports.length > 0 ? (
            <div className="divide-y">
              {data.reports.map((report) => (
                <div key={report.id} className="py-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Bug className="h-4 w-4 text-slate-500" />
                        <span className="font-medium text-slate-900">
                          {report.pageTitle || "Untitled page"}
                        </span>
                        {statusBadge(report)}
                        {screenshotBadge(report)}
                      </div>
                      <p className="break-all text-xs text-slate-500">{report.pageUrl}</p>
                      <p className="line-clamp-2 text-sm text-slate-700">{report.description}</p>
                      <p className="text-xs text-slate-500">
                        {report.member.firstName} {report.member.lastName} - {report.member.email} - {formatDateTime(report.createdAt)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-2"
                      disabled={detailLoading}
                      onClick={() => fetchReportDetail(report.id)}
                    >
                      <Eye className="h-4 w-4" />
                      View
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {data && data.totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-slate-500">
                Page {data.page} of {data.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={page >= data.totalPages}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selectedReport)}
        onOpenChange={(open) => {
          if (!open) setSelectedReport(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
          {selectedReport ? (
            <>
              <DialogHeader>
                <DialogTitle>{selectedReport.pageTitle || "Issue report"}</DialogTitle>
              </DialogHeader>
              <div className="space-y-5">
                <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm sm:grid-cols-2">
                  <div>
                    <p className="text-xs font-medium uppercase text-slate-500">Member</p>
                    <p className="mt-1 text-slate-900">
                      {selectedReport.member.firstName} {selectedReport.member.lastName}
                    </p>
                    <p className="text-slate-600">{selectedReport.member.email}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-slate-500">Submitted</p>
                    <p className="mt-1 text-slate-900">{formatDateTime(selectedReport.createdAt)}</p>
                    <p className="text-slate-600">
                      Screenshot expires {formatDateTime(selectedReport.screenshot.expiresAt)}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {statusBadge(selectedReport)}
                    {screenshotBadge(selectedReport)}
                  </div>
                  <a
                    href={selectedReport.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 break-all text-sm font-medium text-brand-forest hover:underline"
                  >
                    {selectedReport.pageUrl}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Description</p>
                  <div className="whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-700">
                    {selectedReport.description}
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-slate-900">Screenshot</p>
                    {selectedReport.screenshot.retained ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-2 text-red-700"
                        disabled={submitting}
                        onClick={() => updateReport("deleteScreenshot")}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    ) : null}
                  </div>
                  {selectedReport.screenshot.dataUrl ? (
                    <div className="overflow-hidden rounded-md border border-slate-200 bg-slate-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={selectedReport.screenshot.dataUrl}
                        alt="Issue report screenshot"
                        className="max-h-[520px] w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                      Screenshot is not retained for this report.
                    </div>
                  )}
                  {selectedReport.screenshot.deleteReason ? (
                    <p className="mt-2 text-xs text-slate-500">
                      Deletion reason: {selectedReport.screenshot.deleteReason}
                    </p>
                  ) : null}
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium text-slate-900">Browser info</p>
                  <div className="break-all rounded-md border border-slate-200 bg-white p-3 text-xs text-slate-600">
                    {selectedReport.browserInfo.value || "Browser info is not retained for this report."}
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="resolution-note" className="text-sm font-medium text-slate-900">
                    Resolution note
                  </label>
                  <Textarea
                    id="resolution-note"
                    value={resolutionNote}
                    maxLength={1000}
                    onChange={(event) => setResolutionNote(event.target.value)}
                    disabled={submitting}
                    className="min-h-24"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2 sm:gap-0">
                {selectedReport.resolvedAt ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2"
                    disabled={submitting}
                    onClick={() => updateReport("reopen")}
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reopen
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="gap-2"
                    disabled={submitting}
                    onClick={() => updateReport("resolve")}
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Resolve
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
