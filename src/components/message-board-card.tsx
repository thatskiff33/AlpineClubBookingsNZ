import Link from "next/link";
import { ArrowRight, MessageSquare } from "lucide-react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { listClubPostsForMember } from "@/lib/club-posts";
import { clubTime } from "@/lib/club-time/server";

/**
 * Dashboard "Message board" card (#2994): the newest few posts.
 *
 * Renders nothing when the board is empty, the same way `RecentNewsCard` does,
 * so a club that has not started using it sees no empty shell on the dashboard.
 */
export async function MessageBoardCard({ memberId }: { memberId: string }) {
  const { posts } = await listClubPostsForMember(memberId, { take: 3 });
  const club = await clubTime();
  if (posts.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-lg">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
          Message board
        </CardTitle>
        <Link
          href="/message-board"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          Open
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {posts.map((post) => (
            <li key={post.id} className="px-6 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium text-foreground">
                  {post.authorName}
                </span>
                <span className="text-xs text-muted-foreground">
                  {club.instantDate(new Date(post.postedAt))}
                </span>
              </div>
              {/* One line on the dashboard. The full post is on the board;
                  truncating here keeps a long post from taking the page over. */}
              <p className="line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
                {post.content}
              </p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
