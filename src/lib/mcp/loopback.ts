/**
 * Sends one request to this app's own front door (ALP-653, `INV-MCP-007`).
 *
 * An AI app action is not run by calling a route's function. It is sent to the
 * running site as a request, so the module gate in `src/proxy.ts` and every
 * guard in the route run exactly as they do for a browser.
 *
 * `node:http` rather than `fetch`: `fetch` silently replaces a `Host` header
 * with the address it dialled, and the site must see its public host to build
 * links and to apply its redirect rules.
 */
import "server-only";

import { request as httpRequest } from "node:http";

export interface McpLoopbackRequest {
  readonly method: string;
  /** Path and query, starting with `/`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  readonly timeoutMs: number;
  /** Characters of the response body kept. The rest is dropped unread. */
  readonly maxBodyChars: number;
}

export interface McpLoopbackResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
}

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

/** The port this app listens on: `PORT`, as the container sets it. */
function loopbackPort(): number {
  const port = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export function sendMcpLoopbackRequest(input: McpLoopbackRequest): Promise<McpLoopbackResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: LOOPBACK_HOST,
        port: loopbackPort(),
        method: input.method,
        path: input.path,
        headers: {
          ...input.headers,
          ...(input.body === null ? {} : { "content-length": String(Buffer.byteLength(input.body)) }),
        },
      },
      (incoming) => {
        incoming.setEncoding("utf8");
        let body = "";
        let truncated = false;
        incoming.on("data", (chunk: string) => {
          if (truncated) return;
          body += chunk;
          if (body.length > input.maxBodyChars) {
            body = body.slice(0, input.maxBodyChars);
            truncated = true;
          }
        });
        incoming.on("error", reject);
        incoming.on("end", () => {
          const contentType = incoming.headers["content-type"];
          resolve({
            status: incoming.statusCode ?? 0,
            contentType: typeof contentType === "string" ? contentType : "",
            body,
            truncated,
          });
        });
      },
    );
    // A socket timeout measures inactivity: a trickling response could keep
    // it alive forever. Bound the entire action, including reading its body.
    const deadline = setTimeout(() => {
      outgoing.destroy(new Error("The club website took too long to answer."));
    }, input.timeoutMs);
    outgoing.once("close", () => clearTimeout(deadline));
    outgoing.on("error", reject);
    if (input.body !== null) outgoing.write(input.body);
    outgoing.end();
  });
}
