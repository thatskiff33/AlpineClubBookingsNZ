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

type InstructionDocument = {
  key: "OPEN" | "CLOSE" | "DAY_TO_DAY";
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

// Shared typography for the sanitised instruction HTML.
const INSTRUCTION_HTML_CLASSES =
  "text-base leading-7 text-slate-800 [&_a]:text-blue-700 [&_a]:underline [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-4 [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:p-2 [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6";

function formatUpdatedAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return new Date(value).toLocaleDateString("en-NZ", { dateStyle: "long" });
}

export default function LodgeInstructionsPage() {
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
    return <p className="text-sm text-slate-500">Loading lodge instructions...</p>;
  }

  if (notAssigned) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            Lodge Instructions
          </CardTitle>
          <CardDescription>
            You&apos;re not currently assigned as a hut leader.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-600">
            The lodge opening, closing, and day-to-day instructions are only
            available to admins and members with a current or upcoming hut
            leader assignment. If you believe you should have access, please
            contact a club administrator.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (error || !documents) {
    return (
      <p className="text-sm text-red-600">
        {error ?? "Failed to load the lodge instructions. Please try again."}
      </p>
    );
  }

  return (
    <div className="lodge-instructions-print-root space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Lodge Instructions
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Opening, closing, and day-to-day instructions for hut leaders.
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
            className="lodge-instructions-print-section rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
          >
            <h2 className="text-xl font-semibold text-slate-900">
              {doc.title}
            </h2>
            {updated ? (
              <p className="mt-1 text-xs text-slate-500">
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
              <p className="mt-4 text-sm text-slate-500">
                No instructions have been written for this section yet.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
