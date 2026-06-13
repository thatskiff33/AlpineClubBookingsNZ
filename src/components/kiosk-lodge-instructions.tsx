"use client";

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";

type InstructionDocument = {
  key: "OPEN" | "CLOSE" | "DAY_TO_DAY";
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

// Dark-theme typography for the sanitised instruction HTML on the kiosk.
const KIOSK_HTML_CLASSES =
  "text-base leading-7 text-slate-200 [&_a]:text-blue-300 [&_a]:underline [&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-slate-600 [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-600 [&_td]:p-2 [&_th]:border [&_th]:border-slate-600 [&_th]:bg-slate-700 [&_th]:p-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6";

/**
 * Collapsible lodge-instructions section for the kiosk. Rendered only for
 * the admin/hut-leader tiers; the API enforces the same rule server-side.
 */
export function KioskLodgeInstructions({ date }: { date: string }) {
  const [expanded, setExpanded] = useState(false);
  const [openKey, setOpenKey] = useState<InstructionDocument["key"] | null>(
    null,
  );
  const [documents, setDocuments] = useState<InstructionDocument[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // Fetch the documents the first time the section is expanded.
  useEffect(() => {
    if (!expanded || documents !== null) {
      return;
    }

    let cancelled = false;
    fetch(`/api/lodge/instructions?date=${date}`, {
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError("Failed to load the lodge instructions.");
          return;
        }
        const body = (await res.json()) as {
          documents: InstructionDocument[];
        };
        if (!cancelled) {
          setDocuments(body.documents);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load the lodge instructions.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, documents, date]);

  return (
    <section className="bg-slate-800 rounded-2xl p-4 mb-4 border border-slate-700">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 text-left min-h-[44px]"
      >
        <span className="flex items-center gap-2 text-lg font-semibold text-white">
          <BookOpen className="h-5 w-5 text-blue-300" />
          Lodge Instructions
        </span>
        {expanded ? (
          <ChevronUp className="h-5 w-5 text-slate-400" />
        ) : (
          <ChevronDown className="h-5 w-5 text-slate-400" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {error && <p className="text-sm text-red-300">{error}</p>}
          {!error && documents === null && (
            <p className="text-sm text-slate-400">Loading instructions...</p>
          )}
          {documents?.map((doc) => (
            <div
              key={doc.key}
              className="rounded-xl bg-slate-700/40 border border-slate-600/60"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenKey((current) => (current === doc.key ? null : doc.key))
                }
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left min-h-[48px]"
              >
                <span className="text-base font-medium text-white">
                  {doc.title}
                </span>
                {openKey === doc.key ? (
                  <ChevronUp className="h-4 w-4 text-slate-400" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-slate-400" />
                )}
              </button>
              {openKey === doc.key && (
                <div className="border-t border-slate-600/60 px-4 py-3">
                  {doc.contentHtml ? (
                    // contentHtml is sanitised on write and again on read
                    // by the API before it reaches the kiosk.
                    <div
                      className={KIOSK_HTML_CLASSES}
                      dangerouslySetInnerHTML={{ __html: doc.contentHtml }}
                    />
                  ) : (
                    <p className="text-sm text-slate-400">
                      No instructions have been written for this section yet.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
