import Link from "next/link";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * A lodge-hub card that opens one of the lodge's settings sub-pages (Member
 * roster, Central lodge): a title, a line saying what the setting is, and a
 * Configure link. One component so the hub's cards cannot drift apart in
 * shape, and so the hub page stays inside its size budget.
 */
export function LodgeSettingsLinkCard({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-end">
        <Button asChild variant="outline" size="sm">
          <Link href={href}>Configure</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
