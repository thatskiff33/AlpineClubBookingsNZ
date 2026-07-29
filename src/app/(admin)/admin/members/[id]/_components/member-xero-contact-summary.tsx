"use client";

import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { buildXeroContactUrl } from "@/lib/xero-links";
import type { MemberDetail } from "../_types";

export function MemberXeroContactSummary({
  member,
  xeroOrgShortCode,
}: {
  member: MemberDetail;
  /**
   * Organisation short code for the contact deep link, or null when
   * unavailable — the link then degrades to the generic session-scoped Xero
   * URL, it is never hidden (#2283).
   */
  xeroOrgShortCode: string | null;
}) {
  return (
    <div className="text-sm">
      <p className="text-muted-foreground">Xero Contact</p>
      <div className="mt-1 space-y-2 font-medium">
        <div>
          {member.xeroContactId ? (
            <a
              href={buildXeroContactUrl(member.xeroContactId, {
                shortCode: xeroOrgShortCode,
              })}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-info-11 hover:underline"
            >
              {member.xeroContactId}
              <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            "Not linked"
          )}
        </div>
        {!member.xeroContactId && (
          <p className="text-xs text-warning-11">
            Membership refresh skips unlinked members. Link or create a Xero
            contact before expecting subscription status to update
            automatically.
          </p>
        )}
        {member.xeroContactGroups.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {member.xeroContactGroups.map((group) => (
              <Badge
                key={group.id}
                variant="secondary"
                className="bg-success-3 text-success-11 border-success-6"
              >
                {group.name}
              </Badge>
            ))}
          </div>
        )}
        {member.xeroContactId && !member.xeroContactGroupsLoaded && (
          <p className="text-xs text-muted-foreground">
            Cached contact groups have not been refreshed yet.
          </p>
        )}
      </div>
    </div>
  );
}
