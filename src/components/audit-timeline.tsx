"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AUDIT_TIMELINE_CATEGORY_OPTIONS,
  type AuditTimelineEntry,
  type AuditTimelineResponse,
} from "@/lib/audit-query";
import { auditCategoryBadgeClass } from "@/lib/audit-category-badges";
import { useClubTime } from "@/components/club-time-provider";

type AuditTimelineProps = {
  endpoint: string;
  pageSize?: number;
  showMetadata?: boolean;
  showActor?: boolean;
  showAdminEntityLinks?: boolean;
  categoryOptions?: ReadonlyArray<{ value: string; label: string }>;
};

/**
 * The club's own clock, for a trail read against the club's own day.
 *
 * The hand-rolled bag this replaced pinned only the LOCALE, so an officer
 * reading the timeline from overseas saw every entry shifted into their zone
 * (#2264). The stamp is a real INSTANT, so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before - only the zone's AUTHORITY moved, from the environment to
 * the club's recorded setting. A hook because that setting reaches the browser
 * as data through `ClubTimeProvider`, so it is not a module constant any more.
 */
function useAuditTimestampFormatter() {
  const clubTime = useClubTime();
  return (value: string) => clubTime.instantDateTime(new Date(value));
}

function getCategoryLabel(category: string) {
  return (
    AUDIT_TIMELINE_CATEGORY_OPTIONS.find((option) => option.value === category)
      ?.label ?? category
  );
}

function getEntityHref(entry: AuditTimelineEntry, showAdminEntityLinks: boolean) {
  if (!entry.entityType || !entry.entityId) {
    return null;
  }

  if (entry.entityType === "Booking") {
    return `/bookings/${entry.entityId}`;
  }

  if (showAdminEntityLinks && entry.entityType === "Member") {
    return `/admin/members/${entry.entityId}`;
  }

  return null;
}

function hasMetadata(entry: AuditTimelineEntry) {
  if (!entry.metadata) {
    return false;
  }

  if (Array.isArray(entry.metadata)) {
    return entry.metadata.length > 0;
  }

  if (typeof entry.metadata === "object") {
    return Object.keys(entry.metadata).length > 0;
  }

  return true;
}

export function AuditTimeline({
  endpoint,
  pageSize = 10,
  showMetadata = false,
  showActor = true,
  showAdminEntityLinks = false,
  categoryOptions = AUDIT_TIMELINE_CATEGORY_OPTIONS,
}: AuditTimelineProps) {
  const formatDateTime = useAuditTimestampFormatter();
  const [entries, setEntries] = useState<AuditTimelineEntry[]>([]);
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (category !== "all") {
        params.set("category", category);
      }

      const res = await fetch(`${endpoint}?${params.toString()}`);
      const data = (await res.json().catch(() => ({}))) as Partial<AuditTimelineResponse> & {
        error?: string;
      };

      if (!res.ok) {
        throw new Error(data.error || "Failed to load audit history");
      }

      setEntries(data.data ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } catch (err) {
      setEntries([]);
      setTotal(0);
      setTotalPages(1);
      setError(err instanceof Error ? err.message : "Failed to load audit history");
    } finally {
      setLoading(false);
    }
  }, [category, endpoint, page, pageSize]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const rangeLabel = useMemo(() => {
    if (total === 0) {
      return "No records";
    }

    const start = (page - 1) * pageSize + 1;
    const end = Math.min(page * pageSize, total);
    return `${start}-${end} of ${total}`;
  }, [page, pageSize, total]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Select
            value={category}
            onValueChange={(value) => {
              setCategory(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              {categoryOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          ) : null}
        </div>

        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{rangeLabel}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={loading || page <= 1}
            aria-label="Previous audit page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={loading || page >= totalPages}
            aria-label="Next audit page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-3 py-2 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      {!loading && entries.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No audit records</p>
      ) : null}

      <div className="divide-y divide-border">
        {entries.map((entry) => {
          const entityHref = getEntityHref(entry, showAdminEntityLinks);
          const metadataVisible = showMetadata && hasMetadata(entry);

          return (
            <div key={entry.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant="secondary"
                      className={auditCategoryBadgeClass(entry.category)}
                    >
                      {getCategoryLabel(entry.category)}
                    </Badge>
                    {entry.outcome ? (
                      <span className="text-xs capitalize text-muted-foreground">
                        {entry.outcome}
                      </span>
                    ) : null}
                    {entityHref ? (
                      <Button asChild variant="ghost" size="sm" className="h-7 px-2">
                        <Link href={entityHref}>
                          <ExternalLink className="mr-1 h-3.5 w-3.5" />
                          {entry.entityType}
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {entry.summary}
                  </p>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {showActor ? <span>By {entry.actorDisplayName}</span> : null}
                    {entry.entityType && entry.entityId && !entityHref ? (
                      <span>
                        {entry.entityType} {entry.entityId}
                      </span>
                    ) : null}
                    {entry.requestId ? <span>Request {entry.requestId}</span> : null}
                  </div>
                  {entry.description ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {entry.description}
                    </p>
                  ) : entry.details ? (
                    <p className="break-words text-xs text-muted-foreground">
                      {entry.details}
                    </p>
                  ) : null}
                  {metadataVisible ? (
                    <details className="pt-1 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium text-muted-foreground">
                        Metadata
                      </summary>
                      <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-card p-3 text-xs leading-relaxed">
                        {JSON.stringify(entry.metadata, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
                <time className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(entry.createdAt)}
                </time>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
