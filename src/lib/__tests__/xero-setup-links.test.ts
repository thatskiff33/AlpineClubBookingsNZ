import { describe, expect, it } from "vitest";
import { adminHref } from "@/lib/admin-hubs";
import { xeroMappingHref, xeroWebhooksHref } from "@/lib/admin-hubs/xero-setup";

/**
 * The Xero Setup wizard opens a step from `?step=<id>` (#4972). Every shortcut
 * to a step is built by one helper from the same constants the wizard reads;
 * these pin the resulting addresses. While `ADMIN_HUBS_LIVE` is false the page
 * is at its old path, and the literals move with it when that flips (#4815),
 * as the other registry literals do.
 */
describe("Xero Setup step shortcuts", () => {
  it("opens the Account mapping step on Xero Setup", () => {
    expect(xeroMappingHref()).toBe("/admin/xero/setup?step=mapping");
    expect(xeroMappingHref().startsWith(`${adminHref("xero-setup")}?`)).toBe(true);
  });

  it("opens the Webhooks step on Xero Setup", () => {
    expect(xeroWebhooksHref()).toBe("/admin/xero/setup?step=webhooks");
    expect(xeroWebhooksHref().startsWith(`${adminHref("xero-setup")}?`)).toBe(true);
  });
});
