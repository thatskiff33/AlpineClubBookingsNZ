"use client";

import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import {
  adminTabHref,
  parseAdminPageTab,
  type AdminPageTab,
  type AdminTabbedPageId,
} from "@/lib/admin-hubs";

/**
 * The shell of an admin page that holds a merged page as a tab (S1 #4796): its
 * heading (the shared `AdminPageHeader`), then one tab per value the hub registry declares for it. The tab is
 * in the URL (`?tab=`, none for the first), so a retired page's redirect, a
 * link from `adminTabHref` and the page read one value; changing it keeps the
 * rest of the query, less `clearOnChange`. An inactive tab is not mounted, so
 * each tab loads and gates its own content, as the page it was did.
 */
export function AdminPageTabs<Id extends AdminTabbedPageId>({
  page,
  title,
  description,
  tabs,
  clearOnChange = [],
}: {
  page: Id;
  title: ReactNode;
  description: ReactNode;
  tabs: ReadonlyArray<{ value: AdminPageTab<Id>; label: ReactNode; content: ReactNode }>;
  clearOnChange?: readonly string[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseAdminPageTab(page, searchParams.get("tab"));

  function handleTabChange(value: string) {
    const nextTab = parseAdminPageTab(page, value);
    const firstTab = parseAdminPageTab(page, null);
    const params = new URLSearchParams(searchParams.toString());
    for (const key of clearOnChange) params.delete(key);
    if (nextTab === firstTab) params.delete("tab");
    else params.set("tab", nextTab);
    const query = params.toString();
    // The first tab's href is the page's own, with no query.
    const pageHref = adminTabHref(page, firstTab);
    router.replace(`${pageHref}${query ? `?${query}` : ""}`, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader title={title} description={description} />
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          {tabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="mt-6">
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
