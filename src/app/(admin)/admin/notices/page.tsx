"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pin, Plus } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { useClubTime } from "@/components/club-time-provider";
import { parseInstant, type BoundClubTime } from "@/lib/club-time";
import type { AdminNoticeData } from "@/components/admin/notice-editor";

type NoticeGroups = {
  published: AdminNoticeData[];
  draft: AdminNoticeData[];
  archived: AdminNoticeData[];
};

const EMPTY_GROUPS: NoticeGroups = { published: [], draft: [], archived: [] };

const STATUS_LABELS: Record<AdminNoticeData["status"], string> = {
  DRAFT: "Draft",
  PUBLISHED: "Published",
  ARCHIVED: "Archived",
};

const STATUS_VARIANTS: Record<
  AdminNoticeData["status"],
  "secondary" | "success" | "outline"
> = {
  DRAFT: "secondary",
  PUBLISHED: "success",
  ARCHIVED: "outline",
};

const AUDIENCE_KIND_LABELS: Record<string, string> = {
  ALL_MEMBERS: "All members",
  MEMBER: "Member",
  MEMBERSHIP_TYPE: "Membership type",
  LODGE: "Lodge",
  COMMITTEE_ROLE: "Committee role",
};

function audienceLabel(audience: AdminNoticeData["audiences"][number]): string {
  if (audience.kind === "ALL_MEMBERS") return "All members";
  return audience.targetName ?? AUDIENCE_KIND_LABELS[audience.kind] ?? "Target";
}

// `publishedAt` and `updatedAt` are real INSTANTS, shown in the club's
// persisted zone rather than the viewer's (CT-4, #2870; INV-CONFIG-002).
function formatDate(clubTime: BoundClubTime, iso: string | null): string {
  const instant = iso === null ? null : parseInstant(iso);
  if (instant === null) return "—";
  return clubTime.instantDate(instant);
}

function NoticeRow({ notice }: { notice: AdminNoticeData }) {
  const clubTime = useClubTime();
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {notice.pinned ? (
            <Pin
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-label="Pinned"
            />
          ) : null}
          <Link
            href={`/admin/notices/${notice.id}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {notice.title}
          </Link>
          <Badge variant={STATUS_VARIANTS[notice.status]}>
            {STATUS_LABELS[notice.status]}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {notice.audiences.length === 0 ? (
            <Badge variant="outline">No audience</Badge>
          ) : (
            notice.audiences.map((a) => (
              <Badge key={a.id} variant="secondary">
                {audienceLabel(a)}
              </Badge>
            ))
          )}
          {notice.financialMembersOnly ? (
            <Badge variant="outline">Financial only</Badge>
          ) : null}
          {notice.requiresAcknowledgement ? (
            <Badge variant="outline">Ack</Badge>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-1 text-sm sm:items-end">
        <Link
          href={`/admin/notices/${notice.id}`}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          read {notice.readCount} / {notice.audienceCount}
        </Link>
        <span className="text-xs text-muted-foreground">
          {notice.status === "PUBLISHED"
            ? `Published ${formatDate(clubTime, notice.publishedAt)}`
            : `Updated ${formatDate(clubTime, notice.updatedAt)}`}
        </span>
      </div>
    </li>
  );
}

function NoticeSection({
  title,
  description,
  notices,
  emptyText,
}: {
  title: string;
  description: string;
  notices: AdminNoticeData[];
  emptyText: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {notices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="divide-y divide-border">
            {notices.map((notice) => (
              <NoticeRow key={notice.id} notice={notice} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminNoticesPage() {
  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("membership");
  const [groups, setGroups] = useState<NoticeGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch("/api/admin/notices", {
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error("load-failed");
        const data = (await res.json()) as Partial<NoticeGroups>;
        if (cancelled) return;
        setGroups({
          published: data.published ?? [],
          draft: data.draft ?? [],
          archived: data.archived ?? [],
        });
      } catch {
        if (!cancelled) {
          setLoadError("Failed to load notices. Please try again.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view member notices but cannot create or change them.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Member notices</h1>
            <p className="text-sm text-muted-foreground">
              Publish notices to members, target them to groups, and track who
              has read them.
            </p>
          </div>
          <ViewOnlyActionButton
            canEdit={canEdit}
            describeReason={false}
            type="button"
            onClick={() => router.push("/admin/notices/new")}
          >
            <Plus className="mr-2 h-4 w-4" />
            New notice
          </ViewOnlyActionButton>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading notices...</p>
        ) : loadError ? (
          <p className="text-sm text-danger-11">{loadError}</p>
        ) : (
          <>
            <NoticeSection
              title="Published"
              description="Notices currently visible to members."
              notices={groups.published}
              emptyText="No published notices."
            />
            <NoticeSection
              title="Drafts"
              description="Notices not yet published."
              notices={groups.draft}
              emptyText="No draft notices."
            />
            <NoticeSection
              title="Archived"
              description="Notices removed from members' view."
              notices={groups.archived}
              emptyText="No archived notices."
            />
          </>
        )}
      </div>
    </div>
  );
}
