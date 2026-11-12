import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MEMBER_LODGE_ROSTER_LINK } from "@/lib/member-lodge-roster-link";

/**
 * The member dashboard's Lodge Kiosk tile: Open Kiosk while the kiosk module is
 * on, and "Who's at the lodge" (the roster's only entrance) while the roster
 * module is on.
 */
export function LodgeKioskCard({
  showKiosk,
  showRoster,
}: {
  showKiosk: boolean;
  showRoster: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">
          {showKiosk ? "Lodge Kiosk" : "Lodge"}
        </CardTitle>
        <Users className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-lg font-semibold">Who is in the lodge</div>
        <p className="text-xs text-muted-foreground mt-1">
          {showKiosk
            ? "The lodge kiosk will show you who is arriving and leaving the lodge."
            : "See who is staying at the lodge over the next 30 nights."}
        </p>
        {showKiosk && (
          <Button asChild size="sm" variant="outline" className="mt-4 w-full">
            <Link href="/lodge/kiosk">Open Kiosk</Link>
          </Button>
        )}
        {showRoster && (
          <Button
            asChild
            size="sm"
            variant="outline"
            className={`${showKiosk ? "mt-2" : "mt-4"} w-full`}
          >
            <Link href={MEMBER_LODGE_ROSTER_LINK.href}>
              {MEMBER_LODGE_ROSTER_LINK.label}
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
