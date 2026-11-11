"use client";

import { Download } from "lucide-react";
import { toast } from "sonner";

import { fetchWithRecentAuth } from "@/components/confirm-its-you";
import { Button } from "@/components/ui/button";
import { OFFICER_SIGN_IN_ENFORCED } from "@/lib/officer-sign-in-switch";

/**
 * Member CSV export. While officer sign-in is off this stays a normal link.
 * When the switch is on, a plain link cannot open the confirm dialog, so the
 * control fetches the file and saves it under the server's filename.
 */
export function MemberExportControl({ href }: { href: string }) {
  if (!OFFICER_SIGN_IN_ENFORCED) {
    return (
      <Button asChild variant="outline" size="sm">
        <a href={href}>
          <Download className="h-4 w-4 mr-1" />
          Export CSV
        </a>
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        void downloadMemberExport(href);
      }}
    >
      <Download className="h-4 w-4 mr-1" />
      Export CSV
    </Button>
  );
}

async function downloadMemberExport(href: string): Promise<void> {
  const response = await fetchWithRecentAuth(href);
  if (!response.ok) {
    toast.error("Could not export members.");
    return;
  }
  const header = response.headers.get("Content-Disposition") ?? "";
  const named = /filename="([^"]+)"/.exec(header);
  const filename = named?.[1] ?? "members.csv";
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
