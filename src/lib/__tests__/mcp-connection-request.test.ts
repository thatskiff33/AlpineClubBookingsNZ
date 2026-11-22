/**
 * ALP-653: `servingMcpConnection` decides, for a route handler with no
 * `request` argument, whether the request being served is an AI app
 * connection. Presence of the internal principal header is enough; outside a
 * request (no headers to read) it is not a connection.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ headers: vi.fn() }));
vi.mock("next/headers", () => ({ headers: h.headers }));

import { servingMcpConnection } from "@/lib/mcp-connection-request";
import { MCP_PRINCIPAL_HEADER } from "@/lib/mcp/principal";

beforeEach(() => {
  h.headers.mockReset();
});

describe("servingMcpConnection", () => {
  it("is true when the principal header is present", async () => {
    h.headers.mockResolvedValue(new Headers({ [MCP_PRINCIPAL_HEADER]: "anything" }));
    await expect(servingMcpConnection()).resolves.toBe(true);
  });

  it("is false for a browser request without it", async () => {
    h.headers.mockResolvedValue(new Headers({ cookie: "session=1" }));
    await expect(servingMcpConnection()).resolves.toBe(false);
  });

  it("is false outside a request, where reading headers throws", async () => {
    h.headers.mockRejectedValue(new Error("headers was called outside a request scope"));
    await expect(servingMcpConnection()).resolves.toBe(false);
  });
});
