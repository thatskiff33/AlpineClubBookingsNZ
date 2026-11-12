"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { saveResponseAsFile } from "@/lib/save-response-as-file";

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
      await saveResponseAsFile(res, "my-data.json");
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
