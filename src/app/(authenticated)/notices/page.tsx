import Link from "next/link";
import { notFound } from "next/navigation";
import { Newspaper, Pin } from "lucide-react";
import { auth } from "@/lib/auth";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { listNoticesForMember } from "@/lib/notices";
import { clubTime } from "@/lib/club-time/server";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = {
  title: "Recent News",
};

export default async function NoticesPage() {
  const session = await auth();
  if (!session) {
    return null;
  }

  const modules = await loadEffectiveModuleFlags();
  if (!modules.memberNotices) {
    notFound();
  }

  const notices = await listNoticesForMember(session.user.id, { limit: 50 });
  // `publishedAt` is a real INSTANT (a nullable `DateTime`, serialised to ISO by
  // `listNoticesForMember`), so the civil day it reads as comes from the club's
  // PERSISTED timezone rather than the container's (CT-4, #2870; INV-CONFIG-002).
  const club = await clubTime();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2">
        <Newspaper className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold text-foreground">Recent News</h1>
      </div>

      {notices.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            There are no notices for you right now.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent News</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {notices.map((notice) => (
                <li key={notice.id}>
                  <Link
                    href={`/notices/${notice.id}`}
                    className="flex items-center gap-3 px-6 py-4 hover:bg-accent transition-colors"
                  >
                    <span
                      aria-hidden
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        notice.read ? "bg-transparent" : "bg-primary"
                      }`}
                    />
                    <span className="flex-1 min-w-0">
                      <span
                        className={`block ${
                          notice.read
                            ? "text-foreground"
                            : "font-semibold text-foreground"
                        }`}
                      >
                        {notice.pinned ? (
                          <Pin
                            className="mr-1 inline h-4 w-4 text-muted-foreground"
                            aria-label="Pinned"
                          />
                        ) : null}
                        {notice.title}
                        {!notice.read ? (
                          <span className="sr-only"> (unread)</span>
                        ) : null}
                        {notice.requiresAcknowledgement && !notice.acknowledged ? (
                          <span className="ml-2 rounded-full bg-warning-3 px-2 py-0.5 text-xs font-medium text-warning-11">
                            Acknowledgement needed
                          </span>
                        ) : null}
                      </span>
                      {notice.publishedAt ? (
                        <span className="block text-xs text-muted-foreground">
                          {club.instantDate(new Date(notice.publishedAt))}
                        </span>
                      ) : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
