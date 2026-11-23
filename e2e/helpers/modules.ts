import { type APIRequestContext, expect } from "@playwright/test";
import { AI_DIAGNOSTICS_DISCLOSURE_VERSION } from "@/lib/ai-diagnostics-disclosure";

// Club module toggles (Admin > Setup > Modules). The PUT is strict and needs
// every module key, so callers read the current settings, override the keys
// they need, and PUT the whole object back. Use an admin-authenticated request
// context (page.request after signing in a full ADMIN persona).
export type ModuleSettings = Record<string, boolean>;

async function getModuleSettings(
  request: APIRequestContext,
): Promise<ModuleSettings> {
  const res = await request.get("/api/admin/modules");
  expect(res.ok(), `GET /api/admin/modules (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as { settings: ModuleSettings };
  return body.settings;
}

export async function setModuleSettings(
  request: APIRequestContext,
  settings: ModuleSettings,
): Promise<void> {
  // Switching AI Diagnostics on needs the provider disclosure acknowledged
  // (#5243). The route ignores it unless the save switches Diagnostics on.
  const data = settings.aiDiagnostics
    ? { settings, aiDiagnosticsDisclosureAcknowledgedVersion: AI_DIAGNOSTICS_DISCLOSURE_VERSION }
    : { settings };
  const res = await request.put("/api/admin/modules", { data });
  expect(res.ok(), `PUT /api/admin/modules (${res.status()})`).toBeTruthy();
}

// Applies overrides on top of the current settings and returns the previous
// full settings, so the caller can restore them (e.g. in afterAll).
export async function overrideModules(
  request: APIRequestContext,
  overrides: ModuleSettings,
): Promise<ModuleSettings> {
  const previous = await getModuleSettings(request);
  await setModuleSettings(request, { ...previous, ...overrides });
  return previous;
}
