"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, CheckCircle2, Trash2, Wrench } from "lucide-react";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Alert } from "@/components/ui/alert";
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
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";

/**
 * The maintenance officer's queue (#2780, owner decision 4). Lodge Operations.
 *
 * WHAT AN OFFICER DOES HERE, in the order they do it: look at what is open, open
 * one, read the answers and the photo, and move it to In progress or Resolved. The
 * filters default to OPEN for that reason — the queue's job is to show work, not
 * an archive, and a list that opens on "everything ever reported" makes the
 * officer's first action a filter change.
 *
 * THE PHOTO IS FETCHED ONLY WHEN A REPORT IS OPENED. The list endpoint does not
 * return photo bytes at all (`MAINTENANCE_REPORT_LIST_SELECT` omits them), so a
 * page of twenty reports is kilobytes rather than tens of megabytes on a phone.
 * Opening one is also the moment an audit row is written, because opening one is
 * the moment a photograph is disclosed.
 *
 * THE REPORTER IS SHOWN AS ONE OF TWO DIFFERENT THINGS, and the distinction is
 * deliberate rather than cosmetic. A member report carries a verified account. A QR
 * report carries whatever a stranger typed, which the mapper hands over as
 * `selfDeclared*` and this renders under an explicit "says they are" label. An
 * officer must never read an unverified string as an identity the club established.
 */

type QueueAnswer = {
  id: string;
  questionLabel: string;
  questionType: string;
  answerText: string;
};

type QueuePhoto = {
  contentType: string | null;
  capturedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
  deleteReason: string | null;
  retained: boolean;
};

type QueueReport = {
  id: string;
  lodge: { id: string; name: string };
  source: "MEMBER_PORTAL" | "LODGE_QR";
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED";
  summary: string;
  selfDeclaredName: string | null;
  selfDeclaredContact: string | null;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  photo: QueuePhoto;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  answers: QueueAnswer[];
};

type DetailReport = QueueReport & { photo: QueuePhoto & { dataUrl: string | null } };

type ListPayload = {
  reports: QueueReport[];
  lodges: Array<{ id: string; name: string }>;
  total: number;
  page: number;
  pageSize: number;
  outstandingCount: number;
};

const STATUS_LABELS: Record<QueueReport["status"], string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
};

const STATUS_VARIANTS: Record<
  QueueReport["status"],
  "default" | "secondary" | "outline"
> = {
  OPEN: "default",
  IN_PROGRESS: "secondary",
  RESOLVED: "outline",
};

function describeReporter(report: QueueReport): string {
  if (report.member) {
    return `${report.member.firstName} ${report.member.lastName}`.trim();
  }
  if (report.selfDeclaredName) {
    return `Says they are ${report.selfDeclaredName}`;
  }
  return "Reported from a lodge QR code";
}

/**
 * A maintenance stamp in the club's own time.
 *
 * Every value below is a real INSTANT (`createdAt`, `rotatedAt`, `lastUsedAt`,
 * `capturedAt`, `expiresAt`), so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before; only the zone's AUTHORITY moved. A hook because that setting
 * reaches the browser as data through `ClubTimeProvider`.
 */
function useMaintenanceStampFormatter() {
  const clubTime = useClubTime();
  return (value: Date) => clubTime.instantDateTime(value);
}

export function MaintenanceQueueSection() {
  const formatStamp = useMaintenanceStampFormatter();
  const canEdit = useAdminAreaEditAccess("lodge");

  const [status, setStatus] = useState<QueueReport["status"] | "ALL">("OPEN");
  const [lodgeId, setLodgeId] = useState("ALL");
  const [source, setSource] = useState<QueueReport["source"] | "ALL">("ALL");

  const [payload, setPayload] = useState<ListPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [detail, setDetail] = useState<DetailReport | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ status, source });
      if (lodgeId !== "ALL") params.set("lodgeId", lodgeId);
      const res = await fetch(`/api/admin/maintenance-reports?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load the maintenance queue");
      setPayload((await res.json()) as ListPayload);
    } catch {
      setError("The maintenance queue could not be loaded. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [status, lodgeId, source]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setError("");
    setNote("");
    try {
      const res = await fetch(`/api/admin/maintenance-reports/${id}`);
      if (!res.ok) throw new Error("Failed to open that report");
      const data = (await res.json()) as { report: DetailReport };
      setDetail(data.report);
      setNote(data.report.resolutionNote ?? "");
    } catch {
      setError("That report could not be opened. Please try again.");
    } finally {
      setDetailLoading(false);
    }
  }

  async function patchDetail(body: Record<string, unknown>) {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/maintenance-reports/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof data.error === "string" ? data.error : "That change was refused.",
        );
      }
      const data = (await res.json()) as { report: DetailReport | null };
      setDetail(data.report);
      // The list's status and photo columns have just changed underneath, so it is
      // re-read rather than patched locally — the server is the only thing that
      // knows whether a photo is still retained.
      await load();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "That change could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  const reports = payload?.reports ?? [];

  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        You can read the maintenance queue but not change it. Ask an administrator
        with Lodge Operations access to triage a report or remove a photo.
      </AdminViewOnlySectionBanner>

      {error ? (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Reported faults</CardTitle>
          <CardDescription>
            {payload
              ? `${payload.outstandingCount} still to deal with across all lodges.`
              : "Faults members and lodge visitors have reported."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="maintenance-filter-status">Status</Label>
              <Select
                value={status}
                onValueChange={(next) =>
                  setStatus(next as QueueReport["status"] | "ALL")
                }
              >
                <SelectTrigger id="maintenance-filter-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPEN">Open</SelectItem>
                  <SelectItem value="IN_PROGRESS">In progress</SelectItem>
                  <SelectItem value="RESOLVED">Resolved</SelectItem>
                  <SelectItem value="ALL">All</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="maintenance-filter-lodge">Lodge</Label>
              <Select value={lodgeId} onValueChange={setLodgeId}>
                <SelectTrigger id="maintenance-filter-lodge">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All lodges</SelectItem>
                  {(payload?.lodges ?? []).map((lodge) => (
                    <SelectItem key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="maintenance-filter-source">Came from</Label>
              <Select
                value={source}
                onValueChange={(next) =>
                  setSource(next as QueueReport["source"] | "ALL")
                }
              >
                <SelectTrigger id="maintenance-filter-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Anywhere</SelectItem>
                  <SelectItem value="MEMBER_PORTAL">
                    A member&apos;s account
                  </SelectItem>
                  <SelectItem value="LODGE_QR">A lodge QR code</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {loading ? (
            <div className="py-8 text-center">
              <Spinner />
            </div>
          ) : reports.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="Nothing to deal with"
              description={
                status === "OPEN"
                  ? "No open maintenance reports. Change the status filter to see ones already dealt with."
                  : "No maintenance reports match those filters."
              }
            />
          ) : (
            <ul className="divide-y rounded-md border">
              {reports.map((report) => (
                <li
                  key={report.id}
                  className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANTS[report.status]}>
                        {STATUS_LABELS[report.status]}
                      </Badge>
                      <Badge variant="outline">{report.lodge.name}</Badge>
                      {report.source === "LODGE_QR" ? (
                        <Badge variant="outline">QR code</Badge>
                      ) : null}
                      {report.photo.retained ? (
                        <Badge variant="outline" className="gap-1">
                          <Camera className="h-3 w-3" aria-hidden="true" />
                          Photo
                        </Badge>
                      ) : null}
                    </div>
                    <p className="truncate font-medium">{report.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      {describeReporter(report)} ·{" "}
                      {formatStamp(new Date(report.createdAt))}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void openDetail(report.id)}
                    disabled={detailLoading}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {payload && payload.total > reports.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the newest {reports.length} of {payload.total}.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle>{detail.summary}</DialogTitle>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Lodge</dt>
                    <dd>{detail.lodge.name}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Reported</dt>
                    <dd>{formatStamp(new Date(detail.createdAt))}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{STATUS_LABELS[detail.status]}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Came from</dt>
                    <dd>
                      {detail.source === "LODGE_QR"
                        ? "A lodge QR code, without signing in"
                        : "A member's account"}
                    </dd>
                  </div>
                </dl>

                {detail.member ? (
                  <div>
                    <p className="text-muted-foreground">Reported by</p>
                    <p>
                      {detail.member.firstName} {detail.member.lastName} —{" "}
                      {detail.member.email}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-muted-foreground">
                      Reported by (not verified by us)
                    </p>
                    {/* SAID, NOT ESTABLISHED. Free text a stranger typed, labelled so
                        nobody downstream treats it as an identity the club checked. */}
                    <p>
                      {detail.selfDeclaredName
                        ? `Says they are ${detail.selfDeclaredName}`
                        : "Nobody gave a name"}
                      {detail.selfDeclaredContact
                        ? ` · says you can reach them on ${detail.selfDeclaredContact}`
                        : ""}
                    </p>
                  </div>
                )}

                {detail.answers.length > 0 ? (
                  <div className="space-y-2">
                    <p className="font-medium">What they told us</p>
                    <dl className="space-y-2">
                      {detail.answers.map((answer) => (
                        <div key={answer.id}>
                          {/* The label AS ASKED at the time, not today's wording. */}
                          <dt className="text-muted-foreground">
                            {answer.questionLabel}
                          </dt>
                          <dd className="whitespace-pre-wrap">{answer.answerText}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <p className="font-medium">Photo</p>
                  {detail.photo.dataUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element -- a
                          base64 data URL held in this row; next/image cannot optimise
                          one and would only add a proxy hop. */}
                      <img
                        src={detail.photo.dataUrl}
                        alt={`Photo attached to the report: ${detail.summary}`}
                        className="max-h-96 w-full rounded-md border object-contain"
                      />
                      <p className="text-xs text-muted-foreground">
                        Taken {formatStamp(new Date(detail.photo.capturedAt ?? detail.createdAt))}
                        {detail.photo.expiresAt
                          ? ` · deleted automatically after ${formatStamp(new Date(detail.photo.expiresAt))}`
                          : ""}
                      </p>
                    </>
                  ) : detail.photo.deletedAt ? (
                    <p className="text-muted-foreground">
                      The photo has been deleted
                      {detail.photo.deleteReason
                        ? ` — ${detail.photo.deleteReason}`
                        : ""}
                      .
                    </p>
                  ) : detail.photo.capturedAt ? (
                    <p className="text-muted-foreground">
                      A photo was sent with this report, and the time it was kept for
                      has passed. The report itself is kept.
                    </p>
                  ) : (
                    <p className="text-muted-foreground">No photo was sent.</p>
                  )}
                </div>

                {detail.status === "RESOLVED" && detail.resolutionNote ? (
                  <div>
                    <p className="text-muted-foreground">How it was resolved</p>
                    <p className="whitespace-pre-wrap">{detail.resolutionNote}</p>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label htmlFor="maintenance-resolution-note">
                    Note (kept only while the report is resolved)
                  </Label>
                  <Textarea
                    id="maintenance-resolution-note"
                    rows={3}
                    value={note}
                    maxLength={1000}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="What was done about it"
                  />
                </div>
              </div>

              <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  disabled={busy || !detail.photo.dataUrl}
                  onClick={() =>
                    void patchDetail({
                      action: "deletePhoto",
                      reason: "Deleted by an administrator from the queue",
                    })
                  }
                >
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  Delete the photo now
                </ViewOnlyActionButton>

                <div className="flex flex-wrap gap-2">
                  {detail.status !== "OPEN" ? (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void patchDetail({ action: "setStatus", status: "OPEN" })
                      }
                    >
                      Reopen
                    </ViewOnlyActionButton>
                  ) : null}
                  {detail.status !== "IN_PROGRESS" ? (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void patchDetail({
                          action: "setStatus",
                          status: "IN_PROGRESS",
                        })
                      }
                    >
                      Working on it
                    </ViewOnlyActionButton>
                  ) : null}
                  {detail.status !== "RESOLVED" ? (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void patchDetail({
                          action: "setStatus",
                          status: "RESOLVED",
                          ...(note.trim() ? { note: note.trim() } : {}),
                        })
                      }
                    >
                      <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      Mark resolved
                    </ViewOnlyActionButton>
                  ) : null}
                </div>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
