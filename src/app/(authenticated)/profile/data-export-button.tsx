"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";

/**
 * F-COMP-03: Download My Data button.
 * Triggers a GET /api/member/data-export and downloads the file.
 */
export function DataExportButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/member/data-export");
      if (res.status === 429) {
        setError("You've reached the daily export limit (5 per day). Please try again tomorrow.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || "Failed to generate export.");
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      // The captured name is the condition: the group is mandatory, so it is
      // present exactly when the header matched, and the default name already
      // answered its absence (#2801).
      const [, matchedFilename] =
        disposition.match(/filename="(.+?)"/) ?? [];
      const filename = matchedFilename ?? "tac-my-data.json";

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download data. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={handleExport}
        disabled={loading}
        className="gap-2"
      >
        <Download className="h-4 w-4" />
        {loading ? "Generating..." : "Download My Data"}
      </Button>
      {error && <p className="text-sm text-danger-11">{error}</p>}
    </div>
  );
}
