import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { sendMcpLoopbackRequest, type McpLoopbackRequest } from "@/lib/mcp/loopback";

let server: Server | undefined;

async function listen(handler: RequestListener): Promise<void> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  vi.stubEnv("PORT", String(address.port));
}

const request: McpLoopbackRequest = {
  method: "GET",
  path: "/api/example",
  headers: { host: "club.example.test" },
  body: null,
  timeoutMs: 2_000,
  maxBodyChars: 100,
};

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
  }
  vi.unstubAllEnvs();
});

describe("MCP HTTP loopback transport", () => {
  it("dials loopback while preserving the public host, principal, address and UTF-8 body", async () => {
    const body = JSON.stringify({ name: "Māia" });
    let received: unknown;
    await listen((incoming, response) => {
      let text = "";
      incoming.setEncoding("utf8");
      incoming.on("data", (chunk) => { text += chunk; });
      incoming.on("end", () => {
        received = { method: incoming.method, path: incoming.url, headers: incoming.headers, body: text };
        response.writeHead(201, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });

    const result = await sendMcpLoopbackRequest({
      ...request,
      method: "POST",
      path: "/api/example?value=1",
      headers: {
        ...request.headers,
        "x-mcp-principal": "signed-test-principal",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
      },
      body,
    });
    expect(received).toMatchObject({
      method: "POST",
      path: "/api/example?value=1",
      body,
      headers: {
        host: "club.example.test",
        "x-mcp-principal": "signed-test-principal",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.9",
        "content-length": String(Buffer.byteLength(body)),
      },
    });
    expect(result).toEqual({ status: 201, contentType: "application/json", body: '{"ok":true}', truncated: false });
  });

  it("caps decoded characters across chunks and reports truncation", async () => {
    await listen((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("ā".repeat(75));
      response.end("b".repeat(75));
    });
    expect(await sendMcpLoopbackRequest(request)).toEqual({
      status: 200,
      contentType: "text/plain",
      body: "ā".repeat(75) + "b".repeat(25),
      truncated: true,
    });
  });

  it("returns redirects without following them", async () => {
    let calls = 0;
    await listen((_incoming, response) => {
      calls++;
      response.writeHead(302, { location: "/another-route" });
      response.end();
    });
    expect((await sendMcpLoopbackRequest(request)).status).toBe(302);
    expect(calls).toBe(1);
  });

  it("preserves a UTF-8 character split across response chunks", async () => {
    await listen((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      const bytes = Buffer.from("Māia");
      response.write(bytes.subarray(0, 2));
      setImmediate(() => response.end(bytes.subarray(2)));
    });
    expect((await sendMcpLoopbackRequest(request)).body).toBe("Māia");
  });

  it("ends an action that never receives response headers", async () => {
    await listen(() => {
      // The route accepted the connection but has not produced any response.
    });
    await expect(sendMcpLoopbackRequest({ ...request, timeoutMs: 150 }))
      .rejects.toThrow("The club website took too long to answer.");
  });

  it("rejects a partial response when the server drops the connection", async () => {
    await listen((_incoming, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"partial":');
      response.destroy();
    });
    await expect(sendMcpLoopbackRequest(request)).rejects.toThrow();
  });

  it("ends a continuously streaming response at the total deadline", async () => {
    await listen((_incoming, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("start");
      // Traffic keeps an inactivity timeout alive, including after truncation.
      const trickle = setInterval(() => response.write("still running"), 10);
      const finish = setTimeout(() => response.end("finished"), 600);
      response.on("close", () => {
        clearInterval(trickle);
        clearTimeout(finish);
      });
    });
    await expect(sendMcpLoopbackRequest({ ...request, timeoutMs: 150, maxBodyChars: 5 }))
      .rejects.toThrow("The club website took too long to answer.");
  });
});
