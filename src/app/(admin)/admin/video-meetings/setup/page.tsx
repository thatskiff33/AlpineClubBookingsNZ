import type { Metadata } from "next";
import { BackLink } from "@/components/admin/back-link";
import {
  getMirotalkConfigurationStatus,
  readMirotalkStoredSettings,
} from "@/lib/mirotalk-config";
import { VideoMeetingsSetup } from "./video-meetings-setup";
import { getAdminPage } from "@/lib/admin-hubs";

export const metadata: Metadata = {
  title: getAdminPage("video-meetings-setup").label,
};

/**
 * Server component: resolves the METADATA-ONLY configuration status once, then
 * renders the interactive setup. No secret value is read here — only whether
 * each one is set and from where, which is all
 * `getMirotalkConfigurationStatus` is able to return.
 */
export default async function VideoMeetingsSetupPage() {
  const [status, settings] = await Promise.all([
    getMirotalkConfigurationStatus(),
    readMirotalkStoredSettings(),
  ]);

  return (
    <div className="max-w-4xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">{getAdminPage("video-meetings-setup").label}</h1>
      <p className="mb-6 text-muted-foreground">
        Calendar events marked as a meeting carry a Join link to your club&apos;s
        MiroTalk server. Set where that server is, how the links behave, and the
        sign-in your MiroTalk expects. Anything you leave blank keeps using
        whatever the server environment already sets, so an installation that was
        configured before this page existed carries on unchanged.
      </p>

      <VideoMeetingsSetup
        initialStatus={status}
        initialSettings={{
          baseUrl: settings.baseUrl ?? "",
          presenterEnabled: settings.presenterEnabled,
          tokenLifetime: settings.tokenLifetime ?? "",
        }}
        initialSettingsUpdatedAt={settings.updatedAt}
      />
    </div>
  );
}
