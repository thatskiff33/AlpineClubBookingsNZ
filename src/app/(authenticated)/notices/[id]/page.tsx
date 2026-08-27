import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pin } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getNoticeForMember } from "@/lib/notices";
import { clubTime } from "@/lib/club-time/server";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { MarkNoticeRead } from "@/components/mark-notice-read";
import { NoticeAcknowledgeButton } from "@/components/notice-acknowledge-button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function NoticeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session) {
    return null;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.memberNotices) {
    notFound();
  }

  const { id } = await params;
  // getNoticeForMember re-runs the audience predicate. An out-of-audience or
  // non-existent notice both resolve to null -> notFound(), so a member cannot
  // probe the existence of a notice they may not see.
  const notice = await getNoticeForMember(session.user.id, id);
  if (!notice) {
    notFound();
  }

  // Defense in depth: bodyHtml is sanitised on save, but re-sanitise at render
  // so a bypass in the save path can never reach the browser as live markup.
  const safeHtml = sanitizePageContentHtml(notice.bodyHtml);

  // `publishedAt` is a real INSTANT (a nullable `DateTime`, serialised to ISO by
  // `getNoticeForMember`), so the civil day it reads as comes from the club's
  // PERSISTED timezone rather than the container's (CT-4, #2870; INV-CONFIG-002).
  const club = await clubTime();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Client-side read receipt, fired on mount only (never on prefetch). */}
      <MarkNoticeRead noticeId={notice.id} alreadyRead={notice.read} />

      <Link
        href="/notices"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to all news
      </Link>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            {notice.pinned ? (
              <Pin className="h-4 w-4 text-muted-foreground" aria-label="Pinned" />
            ) : null}
            <CardTitle className="text-2xl">{notice.title}</CardTitle>
          </div>
          {notice.publishedAt ? (
            <p className="text-sm text-muted-foreground">
              Posted{" "}
              {club.instantDate(new Date(notice.publishedAt))}
            </p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-6">
          <div
            className="prose prose-sm max-w-none dark:prose-invert"
            // Re-sanitised immediately above; safe to render.
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />

          {notice.requiresAcknowledgement ? (
            <div className="border-t border-border pt-4">
              <NoticeAcknowledgeButton
                noticeId={notice.id}
                acknowledged={notice.acknowledged}
                acknowledgedAt={notice.acknowledgedAt}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
