import { mcpResourceUrl } from "@/lib/mcp/oauth";

import { AiConnectionsClient } from "./ai-connections-client";

export const metadata = {
  title: "AI app connections",
};

// The address is built from the site's own configured URL on each request.
export const dynamic = "force-dynamic";

/**
 * Admin, Help & system: AI app connections (ALP-653, `INV-MCP-002`).
 *
 * Who may connect an AI app, the most a connection may do, the approved apps,
 * and every connection in the club with a Disconnect. In the `support`
 * permission area (`/api/admin/mcp` in `admin-permissions.ts`): view reads,
 * edit changes the settings and disconnects. The page exists only while the
 * `mcpServer` module is on, through its hub registry entry's flag.
 */
export default function AiConnectionsPage() {
  return (
    <div className="max-w-4xl">
      <h1 className="mb-2 text-2xl font-bold text-foreground">AI app connections</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Members can connect an AI app, such as Claude or ChatGPT, to their own
        account on this website. The app then acts as that member: it sees what
        they can see, and nothing more. Paying by card and changing a password
        or sign-in always stay on the website.
      </p>
      <AiConnectionsClient connectAddress={mcpResourceUrl()} />
    </div>
  );
}
