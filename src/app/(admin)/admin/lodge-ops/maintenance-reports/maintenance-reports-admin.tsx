"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MaintenanceQueueSection } from "@/components/admin/maintenance/maintenance-queue-section";
import { MaintenanceSettingsSection } from "@/components/admin/maintenance/maintenance-settings-section";
import { MaintenanceQuestionsSection } from "@/components/admin/maintenance/maintenance-questions-section";
import { MaintenanceQrSection } from "@/components/admin/maintenance/maintenance-qr-section";

/**
 * The Lodge Maintenance admin surface (#2780). One page, four tabs:
 *
 *  - Reports:  the officer's queue — triage, photos, resolve. Opens first
 *    because dealing with reported faults is the everyday job; setup is rare.
 *  - Questions: the club-wide bounded question set the form asks.
 *  - Signs:    per-lodge QR signs — create, print, pause, replace.
 *  - Settings: photos, retention, and the anonymous-QR master switch.
 *
 * Every tab is a self-contained section that owns its own load, edit state and
 * view-only gating; this shell only chooses which one is shown. `moduleEnabled`
 * reaches the Settings tab so its copy can tell an admin the module is off — a
 * near-defensive case, since the feature-route rule 404s this whole page when the
 * module is off, but a proxy/page read race can still land here with it false.
 */
export function MaintenanceReportsAdmin({
  moduleEnabled,
}: {
  moduleEnabled: boolean;
}) {
  return (
    <Tabs defaultValue="queue" className="space-y-4">
      <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
        <TabsTrigger value="queue">Reports</TabsTrigger>
        <TabsTrigger value="questions">Questions</TabsTrigger>
        <TabsTrigger value="signs">Signs</TabsTrigger>
        <TabsTrigger value="settings">Settings</TabsTrigger>
      </TabsList>

      <TabsContent value="queue">
        <MaintenanceQueueSection />
      </TabsContent>
      <TabsContent value="questions">
        <MaintenanceQuestionsSection />
      </TabsContent>
      <TabsContent value="signs">
        <MaintenanceQrSection />
      </TabsContent>
      <TabsContent value="settings">
        <MaintenanceSettingsSection moduleEnabled={moduleEnabled} />
      </TabsContent>
    </Tabs>
  );
}
