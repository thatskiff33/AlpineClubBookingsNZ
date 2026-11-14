import type { XeroClient } from "xero-node";
import { createTestOnlyOverride } from "./test-only-override";

// Test-only provider seam (#4908): a test can hand the app an in-memory Xero
// session (src/test/providers/xero-transport.ts). The guard is the shared
// test-only override rule. Its own module so both the client
// (`getAuthenticatedXeroClient`) and the connection check (`isXeroConnected`)
// read it without importing each other.
type XeroTestSession = { xero: XeroClient; tenantId: string };
const override = createTestOnlyOverride<XeroTestSession>("Xero client");

export const setXeroClientForTests = override.set;
export const resetXeroClientForTests = override.reset;
/** The installed test session, or null. Throws if one is somehow set outside a test. */
export const xeroTestClientOverride = override.read;
