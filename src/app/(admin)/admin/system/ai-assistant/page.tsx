import { BackLink } from "@/components/admin/back-link";
import { getAiAssistantSetupState } from "@/lib/ai-assistant-config";
import { AiAssistantClient } from "./ai-assistant-client";

// AI help assistant admin surface (epic #2094 C4). Registered under the
// `support` permission area (admin-permissions.ts) and hard-gated on the
// `aiAssistant` module flag (feature-routes.ts → proxy 404 when off). Support
// view sees usage + status; support edit can change the monthly spend cap; the
// Anthropic API key WRITE is Full-Admin only (enforced by the credentials
// route). The key is never displayed — only its metadata state.
export const dynamic = "force-dynamic";

export default async function AiAssistantPage() {
  const setup = await getAiAssistantSetupState();

  return (
    <div className="max-w-4xl">
      <BackLink href="/admin/integrations" label="Integrations" />
      <h1 className="mt-2 mb-2 text-2xl font-bold text-foreground">
        AI help assistant
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        The AI assistant answers members&apos; free-text help questions, grounded
        in each page&apos;s curated help content. Enter your Anthropic API key,
        then set a monthly spend cap. Curated page help keeps working with or
        without the assistant.
      </p>
      <AiAssistantClient initialKeyState={setup.state} keySetAt={setup.keySetAt} />
    </div>
  );
}
