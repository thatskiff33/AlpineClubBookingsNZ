import Link from "next/link";
import { notFound } from "next/navigation";
import { MessageSquare } from "lucide-react";

import { auth } from "@/lib/auth";
import { ClubPostBody } from "@/components/club-post-body";
import { ClubPostComposer } from "@/components/club-post-composer";
import { isServerNzConfigured } from "@/lib/servernz-config";
import { Card, CardContent } from "@/components/ui/card";
import {
  listClubPostsForMember,
  MAX_CLUB_POST_LENGTH,
} from "@/lib/club-posts";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { clubTime } from "@/lib/club-time/server";

export const metadata = {
  title: "Message board",
};

/**
 * The club message board (#2994, epic #2992).
 *
 * Everything here is club-local. Sharing a post with other clubs, and seeing
 * theirs, are later children; the composer already carries a disabled share
 * control so the screen does not change shape when they arrive.
 *
 * Paging is by LINK rather than by fetching in the browser: the cursor lives in
 * the query string, so an older page is an ordinary navigation, is shareable,
 * and needs no client-side data loading on mount.
 */
export default async function MessageBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string; beforeId?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.commsPortal) {
    notFound();
  }

  const params = await searchParams;
  const beforeRaw = params.before;
  const parsedBefore = beforeRaw ? new Date(beforeRaw) : undefined;
  // An unreadable cursor falls back to the first page rather than erroring: a
  // truncated or hand-edited link should show the board, not a failure.
  const before =
    parsedBefore && !Number.isNaN(parsedBefore.getTime())
      ? parsedBefore
      : undefined;
  const beforeId = before ? params.beforeId : undefined;

  const { posts, cursor } = await listClubPostsForMember(session.user.id, {
    before,
    beforeId,
  });

  // Post timestamps are instants, shown in the club's own timezone (CT-4,
  // #2870): `formatNZDate` went with the deleted environment-zone adapter.
  const club = await clubTime();

  // Whether the composer may offer sharing at all. A tickbox that cannot do
  // anything is worse than no tickbox: a member ticks it, posts, and reasonably
  // believes other clubs can see it.
  const canShare = await isServerNzConfigured();

  const isFirstPage = !before;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold text-foreground">Message board</h1>
      </div>

      {isFirstPage ? (
        <Card>
          <CardContent className="pt-6">
            <ClubPostComposer
              maxLength={MAX_CLUB_POST_LENGTH}
              canShareToAllClubs={canShare}
            />
          </CardContent>
        </Card>
      ) : null}

      {posts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {isFirstPage
              ? "Nothing on the board yet. Yours can be the first."
              : "No older posts."}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {posts.map((post) => (
            <li key={post.id}>
              {/* Anything on the network -- mirrored FROM another club, or this
                  club's own post shared TO all clubs -- sits on the muted (light
                  grey) ground as well as carrying its badge: colour is scannable
                  at a glance in a way a badge is not. The class names are the
                  contract: `club_message` / `server_message` are STYLE HOOKS for
                  a club's own theme CSS to override, so they must stay stable
                  even if the default styling changes. */}
              <Card
                className={
                  post.originClubName || post.sharedToAllClubs
                    ? "server_message bg-muted"
                    : "club_message"
                }
              >
                <CardContent className="space-y-2 pt-6">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    <span className="font-medium text-foreground">
                      {post.authorName}
                    </span>
                    {post.originClubName ? (
                      <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                        {post.originClubName}
                      </span>
                    ) : null}
                    {post.mine ? (
                      <span className="text-xs text-muted-foreground">You</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {club.instantDate(new Date(post.postedAt))}
                    </span>
                  </div>
                  <ClubPostBody
                    content={post.content}
                    bodyHtml={post.bodyHtml}
                  />
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-between">
        {isFirstPage ? (
          <span />
        ) : (
          <Link
            href="/message-board"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to the latest
          </Link>
        )}
        {cursor ? (
          <Link
            href={`/message-board?before=${encodeURIComponent(cursor.before)}&beforeId=${encodeURIComponent(cursor.beforeId)}`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Older posts →
          </Link>
        ) : null}
      </div>
    </div>
  );
}
