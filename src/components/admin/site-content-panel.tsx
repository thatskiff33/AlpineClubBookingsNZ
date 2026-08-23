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
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubTime } from "@/components/club-time-provider";

// Mirrors SITE_CONTENT_KEYS (src/lib/page-content.ts) and
// SITE_CONTENT_LABELS (src/lib/site-content.ts, server-only).
const SECTIONS = [
  {
    key: "FOOTER_BLURB",
    title: "Footer: club blurb",
    description:
      "Short paragraph under the club logo in the footer's first column. " +
      "Leave a section empty to hide that footer column.",
  },
  {
    key: "FOOTER_QUICK_LINKS",
    title: "Footer: quick links",
    description:
      "Heading and link list in the footer's middle column. " +
      "Leave a section empty to hide that footer column.",
  },
  {
    key: "FOOTER_AFFILIATIONS",
    title: "Footer: affiliations",
    description:
      "Heading and link list in the footer's last column. " +
      "Leave a section empty to hide that footer column.",
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

type ApiDocument = {
  key: SectionKey;
  contentHtml: string;
  updatedAt: string | null;
};

/**
 * "Last saved", in the club's time rather than the admin's own.
 *
 * The stamp says when the CLUB's document changed, so an officer abroad must not
 * read it in their zone (#2264). The stamp is a real INSTANT, so it projects through the club's PERSISTED
 * timezone (CT-4, #2870; INV-CONFIG-002) rather than the container's `TZ`. Same
 * shape as before - only the zone's AUTHORITY moved, from the environment to
 * the club's recorded setting. A hook because that setting reaches the browser
 * as data through `ClubTimeProvider`, so it is not a module constant any more.
 */
function useUpdatedAtFormatter() {
  const clubTime = useClubTime();
  return (value: string | null): string =>
    value ? clubTime.instantDateTime(new Date(value)) : "Never updated";
}

export function SiteContentPanel() {
  const formatUpdatedAt = useUpdatedAtFormatter();
  const canEdit = useAdminAreaEditAccess("content");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Defense-in-depth: a 403 from a stale tab (editors still shown) surfaces a
  // visible, persistent error rather than only an ephemeral toast (#1927).
  const [forbidden, setForbidden] = useState(false);
  const [drafts, setDrafts] = useState<Record<SectionKey, string>>({
    FOOTER_BLURB: "",
    FOOTER_QUICK_LINKS: "",
    FOOTER_AFFILIATIONS: "",
  });
  const [updatedAt, setUpdatedAt] = useState<Record<SectionKey, string | null>>(
    {
      FOOTER_BLURB: null,
      FOOTER_QUICK_LINKS: null,
      FOOTER_AFFILIATIONS: null,
    },
  );
  const [savingKey, setSavingKey] = useState<SectionKey | null>(null);
  const editorRefs = useRef<Record<SectionKey, WysiwygEditorHandle | null>>({
    FOOTER_BLURB: null,
    FOOTER_QUICK_LINKS: null,
    FOOTER_AFFILIATIONS: null,
  });

  // Load all sections for editing.
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/site-content", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      const body = (await res.json()) as { documents: ApiDocument[] };
      const nextDrafts = {
        FOOTER_BLURB: "",
        FOOTER_QUICK_LINKS: "",
        FOOTER_AFFILIATIONS: "",
      } as Record<SectionKey, string>;
      const nextUpdatedAt = {
        FOOTER_BLURB: null,
        FOOTER_QUICK_LINKS: null,
        FOOTER_AFFILIATIONS: null,
      } as Record<SectionKey, string | null>;
      for (const doc of body.documents) {
        nextDrafts[doc.key] = doc.contentHtml;
        nextUpdatedAt[doc.key] = doc.updatedAt;
      }
      setDrafts(nextDrafts);
      setUpdatedAt(nextUpdatedAt);
    } catch {
      setLoadError("Failed to load site content. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  // Save a single section; content is sanitised again server-side.
  async function saveDocument(key: SectionKey, title: string) {
    const contentHtml = editorRefs.current[key]?.getHtml() ?? drafts[key];
    setSavingKey(key);
    setForbidden(false);
    try {
      const res = await fetch("/api/admin/site-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, contentHtml }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setForbidden(true);
        }
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

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings — which is why it is rendered in the
    loading branch too. It sits OUTSIDE the `space-y-*` stack so the empty
    wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view site content but cannot change it. The
      editors below are read-only.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <div>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading site content...</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="space-y-3">
          <p className="text-sm text-danger-11">{loadError}</p>
          <Button type="button" variant="outline" onClick={loadDocuments}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      {forbidden ? <AdminForbiddenSaveNotice /> : null}
      {SECTIONS.map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            <CardDescription>
              {section.description} Last saved:{" "}
              {formatUpdatedAt(updatedAt[section.key])}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Text tokens ({{facebook-url}} etc.) resolve on the public
                footer; the token help button lists what's available. */}
            <WysiwygEditor
              ref={(handle) => {
                editorRefs.current[section.key] = handle;
              }}
              value={drafts[section.key]}
              onChange={(html) =>
                setDrafts((prev) => ({ ...prev, [section.key]: html }))
              }
              placeholder={`Write the ${section.title.toLowerCase()} content...`}
              tokenHelpContext="site-footer"
              readOnly={!canEdit}
              resolvingAccess={canEdit === undefined}
            />
            <div className="flex justify-end">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                type="button"
                onClick={() => saveDocument(section.key, section.title)}
                disabled={savingKey !== null}
              >
                <Save className="mr-2 h-4 w-4" />
                {savingKey === section.key
                  ? "Saving..."
                  : `Save ${section.title}`}
              </ViewOnlyActionButton>
            </div>
          </CardContent>
        </Card>
      ))}
      </div>
    </div>
  );
}
