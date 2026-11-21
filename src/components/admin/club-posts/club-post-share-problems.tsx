"use client";

import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { CopyField } from "@/components/admin/integration-wizard/copy-field";
import { useClubTime } from "@/components/club-time-provider";
import type { AdminShareProblemPost } from "@/lib/club-posts-admin";
import type { ShareProblemKind } from "@/lib/club-post-share-problem";

/**
 * The "Sharing problems" panel on the admin message board (#5246).
 *
 * One entry per post that may be on other clubs' boards in a way this site did
 * not record. Where the central server's id for the copy is known the admin
 * can copy it and withdraw the copy; where it is not, the entry says who to
 * ask and offers "Mark as dealt with". Admin-only: members are never shown
 * any of this.
 */

const BADGE: Record<Exclude<ShareProblemKind, "share-failed">, { label: string; className: string }> = {
  "copy-not-recorded": { label: "Copy on other clubs' boards", className: "bg-warning-3 text-warning-11" },
  "withdrawal-pending": { label: "Removed here, not yet taken down elsewhere", className: "bg-danger-3 text-danger-11" },
  "outcome-unknown": { label: "Share result unknown", className: "bg-warning-3 text-warning-11" },
};

const ASK_THE_ADMINISTRATOR =
  "If withdrawing fails, send this id to the central server's administrator and ask them to take the copy down.";

function explanation(post: AdminShareProblemPost): string {
  switch (post.shareProblem.kind) {
    case "copy-not-recorded":
      return post.removedAt
        ? "The central server accepted this post, but this site could not record that. It was removed here, and its copy may still be on other clubs' boards. It was not sent twice."
        : "The central server accepted this post, but this site could not record that. A copy is on other clubs' boards that this site does not show as shared. It was not sent twice.";
    case "withdrawal-pending":
      return "This post was removed here, but the central server has not confirmed taking it off other clubs' boards. The site retries automatically.";
    case "outcome-unknown":
      return "This post was sent to the central server, but no result was recorded here. It may be on other clubs' boards. This site holds no central server id for it. Ask whoever runs this site to find it in the error log using the post reference below, then ask the central server's administrator to take the copy down.";
    case "share-failed":
      return "";
  }
}

export function ClubPostShareProblems({
  posts,
  canEdit,
  busyId,
  pending,
  inlineError,
  onWithdraw,
  onDismiss,
  ancestorRendersViewOnlyBanner = false,
}: {
  posts: AdminShareProblemPost[];
  canEdit: boolean | undefined;
  busyId: string | null;
  pending: boolean;
  /** A failed action from this panel, shown on its own entry. */
  inlineError: { postId: string; message: string } | null;
  onWithdraw: (postId: string) => void;
  onDismiss: (postId: string) => void;
  /**
   * True only where the parent renders the section's view-only banner above
   * this panel, so the buttons need not repeat its reason (#2168).
   */
  ancestorRendersViewOnlyBanner?: boolean;
}) {
  const club = useClubTime();
  if (posts.length === 0) return null;

  return (
    <section
      aria-labelledby="club-post-share-problems-heading"
      className="mb-4 rounded-lg border border-warning-7 bg-warning-2 p-4"
    >
      <h2 id="club-post-share-problems-heading" className="text-base font-semibold text-foreground">
        Sharing problems ({posts.length})
      </h2>
      <p className="text-sm text-muted-foreground">
        These posts may be visible on other clubs&apos; boards in a way this site did not record.
      </p>
      <ul className="mt-3 divide-y divide-warning-6 border-t border-warning-6">
        {posts.map((post) => {
          const { kind, serverPostId, shareError } = post.shareProblem;
          const badge = BADGE[kind as keyof typeof BADGE];
          const busy = busyId === post.id || pending;
          const failed = inlineError?.postId === post.id ? inlineError.message : null;
          return (
            <li key={post.id} className="space-y-2 py-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <span className="font-medium text-foreground">{post.authorName}</span>
                <span className="text-xs text-muted-foreground">{club.instantDate(new Date(post.postedAt))}</span>
                {badge ? (
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
                ) : null}
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm text-foreground">
                {post.removedAt ? <span className="text-muted-foreground">(text removed)</span> : `“${post.content}”`}
              </p>
              <p className="text-sm text-foreground">{explanation(post)}</p>
              {shareError ? (
                <p className="text-xs text-muted-foreground">Recorded reason: {shareError}</p>
              ) : null}

              {serverPostId ? (
                <>
                  <CopyField label="Central server id" value={serverPostId} />
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    size="sm"
                    disabled={busy}
                    onClick={() => onWithdraw(post.id)}
                  >
                    Withdraw the shared copy
                  </ViewOnlyActionButton>
                  <p className="text-xs text-muted-foreground">{ASK_THE_ADMINISTRATOR}</p>
                </>
              ) : (
                <>
                  <CopyField label="Post reference" value={post.id} />
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={!ancestorRendersViewOnlyBanner}
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDismiss(post.id)}
                  >
                    Mark as dealt with
                  </ViewOnlyActionButton>
                </>
              )}
              {failed ? (
                <p role="alert" className="text-sm text-danger-11">
                  {failed}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
