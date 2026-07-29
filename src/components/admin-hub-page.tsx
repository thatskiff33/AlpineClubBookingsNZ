import type { ReactNode } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

export interface AdminHubSection {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /**
   * Opt in to a HARD document load for this card (a plain `<a>` instead of
   * `next/link`), for the rare destination whose route-scoped
   * Content-Security-Policy relaxation must actually be applied (#2246).
   *
   * CSP is a property of the DOCUMENT, taken from the response headers at parse
   * time. An App Router `<Link>` is a SOFT navigation — no new document — so the
   * destination keeps whatever CSP the entry document was served with, and its
   * own per-route relaxation never takes effect. `/admin/display/builder` needs
   * `frame-src 'self'` for its Live preview; arriving there by `<Link>` from
   * another admin page left the hub's stricter `frame-src` in force and the
   * preview showed "Content blocked".
   *
   * Deliberately opt-in per section rather than applied to every hub card: a
   * full document load is slower, and no other hub destination depends on a
   * route-scoped header.
   */
  hardNavigate?: boolean;
}

function getVisibleAdminHubSections(
  sections: AdminHubSection[],
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
) {
  return sections.filter(
    (section) =>
      isFeatureHrefVisible(section.href, features) &&
      (!permissionMatrix ||
        canViewAdminHrefWithMatrix(permissionMatrix, section.href)),
  );
}

export function AdminHubPage({
  title,
  description,
  sections,
  features,
  permissionMatrix,
  backHref,
  backLabel,
  lead,
}: {
  title: string;
  description: string;
  sections: AdminHubSection[];
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
  /**
   * Optional callout rendered between the hub heading and the card grid, for a
   * hub that has something to say BEFORE its cards — today, the Lobby Display
   * hub leading with its guided-setup card while the club has no boards or no
   * paired screen (#2249).
   *
   * Deliberately a node rather than another card shape: the hub does not decide
   * whether the callout applies, and it must be able to look different from the
   * uniform destination cards below it, which is the whole point of leading
   * with it.
   */
  lead?: ReactNode;
  // Optional back-to-parent link, rendered above the title for a sub-hub that
  // is drilled into from another hub (e.g. the Setup sub-hubs off /admin/setup).
  // Top-level sidebar destinations omit these.
  backHref?: string;
  backLabel?: string;
}) {
  const visibleSections = getVisibleAdminHubSections(
    sections,
    features,
    permissionMatrix,
  );

  return (
    <div className="space-y-8">
      <div>
        {backHref && backLabel ? (
          <div className="mb-2">
            <BackLink href={backHref} label={backLabel} />
          </div>
        ) : null}
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {lead}

      {visibleSections.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleSections.map(
            ({ href, title, description, icon: Icon, hardNavigate }) => {
              const card = (
                <Card className="h-full transition-colors hover:border-brand-gold/70">
                  <CardHeader>
                    <div className="flex items-center gap-2">
                      <Icon className="h-5 w-5 shrink-0 text-foreground" />
                      <CardTitle>{title}</CardTitle>
                    </div>
                    <CardDescription>{description}</CardDescription>
                  </CardHeader>
                </Card>
              );

              // A plain anchor is still a real link: same role, same keyboard
              // activation, same middle-click/ctrl-click/"open in new tab"
              // behaviour. The only difference is that the browser loads a new
              // document, which is exactly what `hardNavigate` asks for (see the
              // field's doc comment).
              return hardNavigate ? (
                <a key={href} href={href} className="group block">
                  {card}
                </a>
              ) : (
                <Link key={href} href={href} className="group block">
                  {card}
                </Link>
              );
            },
          )}
        </div>
      ) : (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground">
          No setup pages are available for your current permissions.
        </div>
      )}
    </div>
  );
}
