// #4940: the TypeScript surface of `server.mjs`, which stays plain JavaScript
// so the pinned Node image runs it with no build. `src/lib/__tests__/load-stripe-stub.test.ts`
// imports it; keep this in step with the `.mjs`.
import type { IncomingMessage, ServerResponse } from "node:http";

export declare function parseStripeForm(text: string): Record<string, unknown>;
export declare function signStripePayload(payload: string, secret: string, timestamp: number): string;
export declare function createStripeStub(options: {
  secretKey: string;
  webhookSecret: string;
  now?: () => number;
}): {
  apiHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  controlHandler(req: IncomingMessage, res: ServerResponse): Promise<void>;
  intents: Map<string, Record<string, unknown>>;
};
