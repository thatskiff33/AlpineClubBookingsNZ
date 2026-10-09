import type { Metadata } from "next";
import { BackLink } from "@/components/admin/back-link";
import { getServerNzSetupState } from "@/lib/servernz-config";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { AlpineServerSetup } from "./alpine-server-setup";

export const metadata: Metadata = {
  title: "Alpine Central Server setup",
};

// Server component: resolves the (metadata-only) connection state once, then
// renders the interactive setup. The API key value is never read here — only
// whether one is stored.
export default async function AlpineServerSetupPage() {
  const [setupState, settings] = await Promise.all([
    getServerNzSetupState(),
    loadServerNzSettings(),
  ]);

  return (
    <div className="max-w-6xl p-6">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold">Alpine Central Server</h1>
      <p className="mb-6 text-muted-foreground">
        Connect this club to the Alpine Central Server (ServerNZ). Request a
        connection, store the API key you are issued, then upload or download the
        data shared across clubs.
      </p>

      <AlpineServerSetup
        initialState={{
          apiKeySet: setupState.apiKeySet,
          apiKeyUpdatedAt: setupState.apiKeyUpdatedAt,
          baseUrl: settings.baseUrl,
          otherLodgesEnabled: settings.otherLodgesEnabled,
          otherLodgesLastUploadAt: settings.otherLodgesLastUploadAt,
          otherLodgesLastDownloadAt: settings.otherLodgesLastDownloadAt,
          // The STORED answer (#49), shown at once; the component then asks
          // the server once on entry through the version route.
          serverVersion: settings.serverVersion,
          serverVersionCheckedAt: settings.serverVersionCheckedAt,
        }}
      />
    </div>
  );
}
