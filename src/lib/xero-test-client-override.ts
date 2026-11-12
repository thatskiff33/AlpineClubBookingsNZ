import type { XeroClient } from "xero-node";

// Test-only provider seam (#4908): a test can hand the app an in-memory Xero
// session (src/test/providers/xero-transport.ts). No environment variable or
// request can set it, and it refuses to serve outside NODE_ENV=test, so a
// changed environment cannot retain it. Its own module so both the client
// (`getAuthenticatedXeroClient`) and the connection check (`isXeroConnected`)
// read it without importing each other.
type XeroTestSession = { xero: XeroClient; tenantId: string };
let testXeroClient: XeroTestSession | null = null;

export function setXeroClientForTests(client: XeroTestSession | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Xero client override is test-only");
  testXeroClient = client;
}

export function resetXeroClientForTests(): void {
  testXeroClient = null;
}

/** The installed test session, or null. Throws if one is somehow set outside a test. */
export function xeroTestClientOverride(): XeroTestSession | null {
  if (testXeroClient && process.env.NODE_ENV !== "test") throw new Error("Xero client override is test-only");
  return testXeroClient;
}
