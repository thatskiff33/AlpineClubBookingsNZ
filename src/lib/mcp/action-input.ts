/**
 * An action's arguments as an app sends them: one flat object, checked and
 * split into the route's path, query and body (`catalogue.ts` defines them).
 */
import { z } from "zod";

import type { McpAction, ObjectSchema } from "./catalogue";

const EMPTY_INPUT = z.object({});

/**
 * The one flat object an app sends for an action: its path, query and body
 * fields together. The catalogue test refuses an action whose three parts
 * share a key, so each argument has one destination.
 */
export function mcpActionInputSchema(action: McpAction): ObjectSchema {
  const shape = {
    ...action.params?.shape,
    ...action.query?.shape,
    ...action.body?.shape,
  };
  return Object.keys(shape).length === 0 ? EMPTY_INPUT : z.object(shape);
}

/**
 * JSON Schema for an action's arguments as the app must send them: `io:
 * "input"` describes a date as the string the route parses, not the value the
 * route's transform produces.
 */
export function mcpActionInputJsonSchema(action: McpAction): Record<string, unknown> {
  const schema = z.toJSONSchema(mcpActionInputSchema(action), {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return { ...schema, type: "object" };
}

/** Where each of an app's flat arguments goes on the request. */
export function splitMcpActionArguments(
  action: McpAction,
  args: Readonly<Record<string, unknown>>,
): {
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly body: Record<string, unknown> | null;
} {
  const pick = (schema: ObjectSchema | undefined) => {
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(schema?.shape ?? {})) {
      if (args[key] !== undefined) picked[key] = args[key];
    }
    return picked;
  };
  const hasBody = action.body !== undefined || action.fixedBody !== undefined;
  return {
    params: pick(action.params),
    query: pick(action.query),
    // `fixedBody` is spread last: an app cannot turn a draft into a booking.
    body: hasBody ? { ...pick(action.body), ...action.fixedBody } : null,
  };
}
