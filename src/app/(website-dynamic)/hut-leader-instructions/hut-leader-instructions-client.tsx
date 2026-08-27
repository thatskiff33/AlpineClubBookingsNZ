"use client";

import { useState } from "react";
import { Printer, ShieldAlert, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useClubTime } from "@/components/club-time-provider";

type InstructionDocument = {
  key: "OPEN" | "CLOSE" | "DAY_TO_DAY";
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

// Shared typography for the sanitised instruction HTML (parity with the
// login/kiosk instruction surfaces). contentHtml is sanitised server-side.
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

export function HutLeaderInstructionsClient({
  assignmentId,
}: {
  assignmentId: string | null;
}) {
  const formatUpdatedAt = useUpdatedAtFormatter();
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<InstructionDocument[] | null>(null);

  // No assignment reference in the link — nothing we can verify against.
  if (!assignmentId) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning-11" />
            Lodge Instructions
          </CardTitle>
          <CardDescription>This link is incomplete.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Please open the lodge instructions using the link in your assignment
            email. If it still doesn&apos;t work, contact a club administrator.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/lodge/instructions/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId, pin }),
      });
      if (res.ok) {
        const body = (await res.json()) as { documents: InstructionDocument[] };
        setDocuments(body.documents);
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Please wait a few minutes and try again.");
      } else if (res.status === 401) {
        setError("That link and PIN don't match. Check your assignment email.");
      } else if (res.status === 400) {
        setError("Please enter your 6-digit kiosk PIN.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Verified — show the instructions.
  if (documents) {
    return (
      <div className="lodge-instructions-print-root space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
          <div>
            <h1 className="text-2xl font-bold text-foreground">
              Lodge Instructions
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Opening, closing, and day-to-day instructions for your stay. Print
              a copy to bring with you.
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => window.print()}>
            <Printer className="mr-2 h-4 w-4" />
            Print
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
                <div
                  className={`mt-4 ${INSTRUCTION_HTML_CLASSES}`}
                  // Sanitised server-side (sanitizePageContentHtml) before it
                  // reaches the client.
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

  // PIN entry.
  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-muted-foreground" />
          Lodge Instructions
        </CardTitle>
        <CardDescription>
          Enter the kiosk PIN from your assignment email to view the opening,
          closing, and day-to-day instructions for your stay.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="hut-leader-pin">Kiosk PIN</Label>
            <Input
              id="hut-leader-pin"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="\d{6}"
              placeholder="6-digit PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="tracking-[0.4em] text-center text-lg"
            />
          </div>
          {error ? <p className="text-sm text-danger-11">{error}</p> : null}
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || pin.length !== 6}
          >
            {submitting ? "Checking..." : "View instructions"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
