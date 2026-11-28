import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export interface KpiStatCardProps {
  title: string;
  value: string;
  description?: string;
  footnote?: string;
}

/**
 * A single headline metric card. Presentational only (no charts), so it renders
 * on the server alongside the finance pages.
 */
export function KpiStatCard({
  title,
  value,
  description,
  footnote,
}: KpiStatCardProps) {
  return (
    <Card className="reports-print-card">
      <CardHeader className="pb-3">
        <CardDescription>{title}</CardDescription>
        {/* The figure itself, drawn large: a value under its label, not a
            heading (INV-PUB-006). */}
        <CardTitle headingLevel="none" className="text-3xl text-card-foreground">{value}</CardTitle>
      </CardHeader>
      {description || footnote ? (
        <CardContent className="space-y-2">
          {description ? (
            <p className="text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
          {footnote ? (
            <p className="text-xs font-medium text-muted-foreground">
              {footnote}
            </p>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
