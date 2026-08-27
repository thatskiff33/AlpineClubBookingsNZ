"use client";

import { useEffect, useState } from "react";
import { Printer, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useClubIdentity } from "@/components/club-identity-provider";
import { useClubTime } from "@/components/club-time-provider";

type InstructionDocument = {
  key: "OPEN" | "CLOSE" | "DAY_TO_DAY";
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

// Shared typography for the sanitised instruction HTML.
const INSTRUCTION_HTML_CLASSES =
  "text-base leading-7 text-foreground [&_a]:text-info-11 [&_a]:underline [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-4 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6";

/**
 * The instructions' "last updated" stamp, projected through the club's PERSISTED
 * timezone (CT-4, #2870; epic #2988; INV-CONFIG-002).
 *
 * `updatedAt` is a real INSTANT, so it has no civil date until a zone is chosen.
 * It used to be `APP_TIME_ZONE` — the container's `TZ` — which is the club's
 * zone only by accident. Same shape and the same long form INV-DATE-016 reserves
 * for this surface (#2264, owner decision); only the AUTHORITY moved. A hook
 * because that setting reaches the browser as data through `ClubTimeProvider`,
 * so it is not a module constant any more.
 */
function useUpdatedAtFormatter() {
  const clubTime = useClubTime();
  // The FALSY guard the module function used, kept deliberately: the payload is
  // typed `string | null` but nothing validates it on the way in, and an empty
  // string would reach `Intl` as an invalid Date and throw out of a client
  // render. Rendering no stamp at all is what this surface did before.
  return (value: string | null): string | null =>
    value ? clubTime.instantLongDate(new Date(value)) : null;
}

export default function LodgeInstructionsPage() {
  const { hutLeaderLabel } = useClubIdentity();
  const formatUpdatedAt = useUpdatedAtFormatter();
  const hutLeaderLower = hutLeaderLabel.toLowerCase();
  const [documents, setDocuments] = useState<InstructionDocument[] | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [notAssigned, setNotAssigned] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // The API enforces access: admins and members with a current or
    // upcoming hut leader assignment only. 403 means "not assigned".
    fetch("/api/lodge-instructions", { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setNotAssigned(true);
          return;
        }
        if (!res.ok) {
          setError("Failed to load the lodge instructions. Please try again.");
          return;
        }
        const body = (await res.json()) as {
          documents: InstructionDocument[];
        };
        if (!cancelled) {
          setDocuments(body.documents);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load the lodge instructions. Please try again.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading lodge instructions...</p>;
  }

  if (notAssigned) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning-11" />
            Lodge Instructions
          </CardTitle>
          <CardDescription>
            You&apos;re not currently assigned as a {hutLeaderLower}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The lodge opening, closing, and day-to-day instructions are only
            available to admins and members with a current or upcoming{" "}
            {hutLeaderLower} assignment. If you believe you should have access,
            please contact a club administrator.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error || !documents) {
    return (
      <p className="text-sm text-danger-11">
        {error ?? "Failed to load the lodge instructions. Please try again."}
      </p>
    );
  }

  return (
    <div className="lodge-instructions-print-root space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Lodge Instructions
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Opening, closing, and day-to-day instructions for {hutLeaderLower}s.
            Print a copy to pin up in the lodge.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => window.print()}>
          <Printer className="mr-2 h-4 w-4" />
          Print Instructions
        </Button>
      </div>

      {documents.map((doc) => {
        const updated = formatUpdatedAt(doc.updatedAt);
        return (
          <section
            key={doc.key}
            className="lodge-instructions-print-section rounded-lg border border-border bg-card p-6 shadow-sm"
          >
            <h2 className="text-xl font-semibold text-foreground">
              {doc.title}
            </h2>
            {updated ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Last updated {updated}
              </p>
            ) : null}
            {doc.contentHtml ? (
              // contentHtml is sanitised on write and again on read by the
              // API (sanitizePageContentHtml) before it reaches the client.
              <div
                className={`mt-4 ${INSTRUCTION_HTML_CLASSES}`}
                dangerouslySetInnerHTML={{ __html: doc.contentHtml }}
              />
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">
                No instructions have been written for this section yet.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
