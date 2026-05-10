import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface ProfileSectionCardProps {
  children: ReactNode;
  title: string;
  collapsible?: boolean;
  contentClassName?: string;
  defaultOpen?: boolean;
  description?: string;
  id?: string;
}

export function ProfileSectionCard({
  children,
  collapsible = false,
  contentClassName,
  defaultOpen = true,
  description,
  id,
  title,
}: ProfileSectionCardProps) {
  if (!collapsible) {
    return (
      <Card id={id}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className={contentClassName}>{children}</CardContent>
      </Card>
    );
  }

  return (
    <Card id={id}>
      <details
        className="group [&_summary::-webkit-details-marker]:hidden"
        open={defaultOpen}
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-6 py-6">
          <div className="space-y-1.5">
            <CardTitle>{title}</CardTitle>
            {description ? (
              <CardDescription>{description}</CardDescription>
            ) : null}
          </div>
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <CardContent className={cn("pt-0", contentClassName)}>
          {children}
        </CardContent>
      </details>
    </Card>
  );
}
