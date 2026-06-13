"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  WysiwygEditor,
  type WysiwygEditorHandle,
} from "@/components/admin/page-content-panel";

// Mirrors LODGE_INSTRUCTION_KEYS / LODGE_INSTRUCTION_LABELS in
// src/lib/lodge-instructions.ts (that module is server-only).
const DOCUMENTS = [
  {
    key: "OPEN",
    title: "Opening the Lodge",
    description: "Steps to open the lodge at the start of a stay or season.",
  },
  {
    key: "CLOSE",
    title: "Closing the Lodge",
    description: "Steps to shut the lodge down safely before leaving.",
  },
  {
    key: "DAY_TO_DAY",
    title: "Day-to-Day Running",
    description: "Daily routines and duties while the lodge is occupied.",
  },
] as const;

type DocumentKey = (typeof DOCUMENTS)[number]["key"];

type ApiDocument = {
  key: DocumentKey;
  contentHtml: string;
  updatedAt: string | null;
};

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "Never updated";
  }
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function LodgeInstructionsPanel() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<DocumentKey, string>>({
    OPEN: "",
    CLOSE: "",
    DAY_TO_DAY: "",
  });
  const [updatedAt, setUpdatedAt] = useState<
    Record<DocumentKey, string | null>
  >({
    OPEN: null,
    CLOSE: null,
    DAY_TO_DAY: null,
  });
  const [savingKey, setSavingKey] = useState<DocumentKey | null>(null);
  const editorRefs = useRef<
    Record<DocumentKey, WysiwygEditorHandle | null>
  >({
    OPEN: null,
    CLOSE: null,
    DAY_TO_DAY: null,
  });

  // Load all three documents for editing.
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/lodge-instructions", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      const body = (await res.json()) as { documents: ApiDocument[] };
      const nextDrafts = { OPEN: "", CLOSE: "", DAY_TO_DAY: "" } as Record<
        DocumentKey,
        string
      >;
      const nextUpdatedAt = {
        OPEN: null,
        CLOSE: null,
        DAY_TO_DAY: null,
      } as Record<DocumentKey, string | null>;
      for (const doc of body.documents) {
        nextDrafts[doc.key] = doc.contentHtml;
        nextUpdatedAt[doc.key] = doc.updatedAt;
      }
      setDrafts(nextDrafts);
      setUpdatedAt(nextUpdatedAt);
    } catch {
      setLoadError("Failed to load lodge instructions. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  // Save a single document; content is sanitised again server-side.
  async function saveDocument(key: DocumentKey, title: string) {
    const contentHtml = editorRefs.current[key]?.getHtml() ?? drafts[key];
    setSavingKey(key);
    try {
      const res = await fetch("/api/admin/lodge-instructions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, contentHtml }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Failed to save ${title}`);
        return;
      }
      const body = (await res.json()) as { document: ApiDocument };
      setDrafts((prev) => ({ ...prev, [key]: body.document.contentHtml }));
      setUpdatedAt((prev) => ({ ...prev, [key]: body.document.updatedAt }));
      toast.success(`${title} saved`);
    } catch {
      toast.error(`Failed to save ${title}`);
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading lodge instructions...</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600">{loadError}</p>
        <Button type="button" variant="outline" onClick={loadDocuments}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {DOCUMENTS.map((doc) => (
        <Card key={doc.key}>
          <CardHeader>
            <CardTitle>{doc.title}</CardTitle>
            <CardDescription>
              {doc.description} Last saved: {formatUpdatedAt(updatedAt[doc.key])}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <WysiwygEditor
              ref={(handle) => {
                editorRefs.current[doc.key] = handle;
              }}
              value={drafts[doc.key]}
              onChange={(html) =>
                setDrafts((prev) => ({ ...prev, [doc.key]: html }))
              }
              placeholder={`Write the ${doc.title.toLowerCase()} instructions...`}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => saveDocument(doc.key, doc.title)}
                disabled={savingKey !== null}
              >
                <Save className="mr-2 h-4 w-4" />
                {savingKey === doc.key ? "Saving..." : `Save ${doc.title}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
