"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { BackLink } from "@/components/admin/back-link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  NoticeEditor,
  type AdminNoticeData,
} from "@/components/admin/notice-editor";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";

const READS_PAGE_SIZE = 25;

type ReadRow = {
  memberId: string;
  name: string;
  email: string;
  audienceVia: string;
  readAt: string | null;
  acknowledgedAt: string | null;
};

type ReadsResponse = {
  requiresAcknowledgement: boolean;
  rows: ReadRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  audienceCount: number;
  readCount: number;
  acknowledgedCount: number;
};

// When a member read or acknowledged a notice — real INSTANTS, shown in the
// club's persisted zone rather than the viewer's (CT-4, #2870).
function formatDateTime(clubTime: BoundClubTime, iso: string | null): string {
  const instant = iso === null ? null : parseInstant(iso);
  if (instant === null) return "—";
  return clubTime.instantDateTime(instant);
}

function ReadStatusTable({ noticeId }: { noticeId: string }) {
  const clubTime = useClubTime();
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReadsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/notices/${noticeId}/reads?page=${page}&pageSize=${READS_PAGE_SIZE}`,
        { credentials: "same-origin" },
      );
      if (!res.ok) throw new Error("load-failed");
      const body = (await res.json()) as ReadsResponse;
      setData(body);
    } catch {
      setError("Failed to load read status. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [noticeId, page]);

  useEffect(() => {
    load();
  }, [load]);

  const showAck = data?.requiresAcknowledgement ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Read status</CardTitle>
        <CardDescription>
          {data
            ? `${data.readCount} of ${data.audienceCount} in the audience have read this notice` +
              (data.requiresAcknowledgement
                ? `, ${data.acknowledgedCount} acknowledged.`
                : ".")
            : "Who has seen this notice."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading read status...</p>
        ) : error ? (
          <div className="space-y-3">
            <p className="text-sm text-danger-11">{error}</p>
            <Button type="button" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No members in this notice&apos;s audience yet.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Audience via</TableHead>
                  <TableHead>Read</TableHead>
                  {showAck ? <TableHead>Acknowledged</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.memberId}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.email}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.audienceVia}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(clubTime, row.readAt)}
                    </TableCell>
                    {showAck ? (
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(clubTime, row.acknowledgedAt)}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data.totalPages > 1 ? (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Page {data.page} of {data.totalPages} ({data.total} members)
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || data.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading || data.page >= data.totalPages}
                    onClick={() =>
                      setPage((p) => Math.min(data.totalPages, p + 1))
                    }
                  >
                    Next
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function EditNoticePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [notice, setNotice] = useState<AdminNoticeData | null | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setLoadError(null);
      try {
        const res = await fetch(`/api/admin/notices/${id}`, {
          credentials: "same-origin",
        });
        if (res.status === 404) {
          if (!cancelled) setNotice(null);
          return;
        }
        if (!res.ok) throw new Error("load-failed");
        const data = (await res.json()) as { notice: AdminNoticeData };
        if (cancelled) return;
        setNotice(data.notice ?? null);
      } catch {
        if (!cancelled) {
          setLoadError("Failed to load this notice. Please try again.");
          setNotice(null);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="space-y-4">
      <BackLink href="/admin/notices" label="Member notices" />

      {notice === undefined ? (
        <p className="text-sm text-muted-foreground">Loading notice...</p>
      ) : notice === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Notice not found</CardTitle>
            <CardDescription>
              {loadError ??
                "This notice does not exist or has been deleted."}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="space-y-6">
          <NoticeEditor mode="edit" notice={notice} />
          <ReadStatusTable noticeId={notice.id} />
        </div>
      )}
    </div>
  );
}
