/**
 * Runs one AI app action as the member who approved the connection (ALP-653,
 * `INV-MCP-007`).
 *
 * The call is sent to the site's own front door (`loopback.ts`) carrying the
 * signed principal header, the public `Host`, and the caller's address. It
 * never imports a route handler. What the member may do is decided by the
 * route, as it is for a browser; this module only refuses earlier:
 *
 * - a route that is never an action (`exclusions.ts`), even if a catalogue
 *   entry were added for it by mistake;
 * - a change through a view-only connection.
 *
 * Every call that is not a read leaves one audit row: which action, which app,
 * and how it ended. Never the arguments or the result (`INV-PRIV-011`).
 */
import "server-only";

import type { McpGrantScope } from "@prisma/client";

import { getAppBaseUrl } from "@/lib/app-url";
import logger from "@/lib/logger";
import { FORWARDED_FOR_HEADER } from "@/lib/rate-limit-http";

import { recordMcpAudit } from "./audit";
import {
  mcpActionAdminRequirement,
  mcpActionInputSchema,
  mcpActionRouteFile,
  splitMcpActionArguments,
  type McpAction,
  type McpWebsiteOnlyAction,
} from "./catalogue";
import { MCP_PERMANENT_EXCLUSION_REASONS, mcpPermanentExclusion } from "./exclusions";
import { sendMcpLoopbackRequest } from "./loopback";
import { issueMcpPrincipal, MCP_PRINCIPAL_HEADER } from "./principal";
import { MCP_SCOPE_LABELS } from "./scope-labels";
import { mcpScopeAllows } from "./settings";

/**
 * What an argument that becomes part of an address must look like: one record
 * id. Encoding alone leaves `.` and `..` intact, and those would move the call
 * to a route other than the one the catalogue names.
 */
const ADDRESS_ARGUMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** The longest an app waits on one action before it is told to try again. */
const MCP_ACTION_TIMEOUT_MS = 25_000;
/** The most of one result an app is handed. A longer one is cut and says so. */
export const MCP_RESULT_MAX_CHARS = 100_000;

export interface McpCaller {
  readonly grantId: string;
  readonly memberId: string;
  /** The connected app's name as the member saw it on the approval screen. */
  readonly clientName: string;
  /** The lesser of what the member approved and what the club allows now. */
  readonly scope: McpGrantScope;
  /**
   * An officer approved this connection on the screen that says the app can
   * act as an officer. Without it no officer action is offered or run
   * (`INV-MCP-009`); member actions are unaffected.
   */
  readonly officerConsent: boolean;
  readonly clientIp: string;
  readonly userAgent: string | null;
}

export interface McpActionOutcome {
  readonly isError: boolean;
  readonly text: string;
}

function refusal(text: string): McpActionOutcome {
  return { isError: true, text };
}

/** The answer to an action only the website can do: where to go, and nothing runs. */
export function websiteOnlyAnswer(
  action: McpWebsiteOnlyAction,
  args: Readonly<Record<string, unknown>>,
): McpActionOutcome {
  const origin = getAppBaseUrl();
  const id = typeof args.id === "string" ? args.id : "";
  if (action.needsId && !ADDRESS_ARGUMENT.test(id)) {
    return refusal(`${action.title} needs the \`id\` of the booking.`);
  }
  const page = action.page.replace("{id}", encodeURIComponent(id));
  return {
    isError: false,
    text: `${action.summary} Nothing was done. The member can do this at ${origin}${page}`,
  };
}

function buildPath(action: McpAction, params: Record<string, unknown>, query: Record<string, unknown>): string {
  const path = action.path.replace(/\[([A-Za-z]+)\]/g, (_match, key: string) =>
    encodeURIComponent(String(params[key])),
  );
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) search.set(key, String(value));
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues
    .slice(0, 10)
    .map((issue) => `${issue.path.map(String).join(".") || "(arguments)"}: ${issue.message}`)
    .join("; ");
}

function nextStepSentence(action: McpAction, body: string): string | null {
  if (!action.nextStep) return null;
  let id = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string") {
      id = parsed.id;
    }
  } catch {
    // A result that is not JSON has no id to link to.
  }
  if (!id) return null;
  return action.nextStep.replace("{origin}", getAppBaseUrl()).replace("{id}", encodeURIComponent(id));
}

async function recordCall(action: McpAction, caller: McpCaller, status: number | null): Promise<void> {
  if (action.kind === "read") return;
  const succeeded = status !== null && status >= 200 && status < 300;
  try {
    await recordMcpAudit({
      action: "MCP_ACTION_CALLED",
      actorMemberId: caller.memberId,
      // A member action acts on the connected member's own records: a draft
      // is theirs, and the cancel route refuses a connection any booking but
      // its member's own (`INV-MCP-006`). An officer action acts on the
      // club's records, so the row names no subject: the route's own audit
      // row names the record it changed, as it does for the admin screen.
      subjectMemberId: mcpActionAdminRequirement(action) === null ? caller.memberId : undefined,
      grantId: caller.grantId,
      severity: action.kind === "destructive" ? "important" : "info",
      succeeded,
      summary: `AI app "${caller.clientName}" ran ${action.id}`,
      metadata: { actionId: action.id, clientName: caller.clientName, status },
      request: { ipAddress: caller.clientIp, userAgent: caller.userAgent },
    });
  } catch (err) {
    // The action has already run or been refused; a failed audit write must
    // not turn into a second attempt by the app.
    logger.error({ err, actionId: action.id }, "Failed to record an AI app action");
  }
}

export async function runMcpAction(
  action: McpAction,
  args: Readonly<Record<string, unknown>>,
  caller: McpCaller,
): Promise<McpActionOutcome> {
  const origin = getAppBaseUrl();

  const excluded = mcpPermanentExclusion(mcpActionRouteFile(action), action.method);
  if (excluded) {
    return refusal(
      `${MCP_PERMANENT_EXCLUSION_REASONS[excluded]} Nothing was done. The member can do this on the club website: ${origin}`,
    );
  }

  if (!mcpScopeAllows(caller.scope, action.kind)) {
    await recordCall(action, caller, null);
    return refusal(
      `This connection is "${MCP_SCOPE_LABELS.READ}", so "${action.title}" was not run. To let the app make changes, the member connects it again from ${origin}/profile and chooses "${MCP_SCOPE_LABELS.READ_WRITE}", if the club allows it.`,
    );
  }

  const parsed = mcpActionInputSchema(action).safeParse(args);
  if (!parsed.success) {
    return refusal(`The arguments were not valid, so nothing was done. ${describeIssues(parsed.error.issues)}`);
  }

  // The app's own values are forwarded, not the parsed ones: the route parses
  // them again, and a parsed date is no longer the string the route expects.
  const { params, query, body } = splitMcpActionArguments(action, args);
  const unsafe = Object.entries(params).find(
    ([, value]) => typeof value !== "string" || !ADDRESS_ARGUMENT.test(value),
  );
  if (unsafe) {
    return refusal(`The \`${unsafe[0]}\` argument is not a record id, so nothing was done.`);
  }
  const publicUrl = new URL(origin);
  const principal = issueMcpPrincipal(caller.grantId, Date.now());

  let response;
  try {
    response = await sendMcpLoopbackRequest({
      method: action.method,
      path: buildPath(action, params, query),
      headers: {
        host: publicUrl.host,
        "x-forwarded-proto": publicUrl.protocol.replace(":", ""),
        [FORWARDED_FOR_HEADER]: caller.clientIp,
        accept: "application/json",
        "user-agent": caller.userAgent ?? "ai-app-connection",
        [MCP_PRINCIPAL_HEADER]: principal.value,
        ...(body === null ? {} : { "content-type": "application/json" }),
      },
      body: body === null ? null : JSON.stringify(body),
      timeoutMs: MCP_ACTION_TIMEOUT_MS,
      maxBodyChars: MCP_RESULT_MAX_CHARS,
    });
  } catch (err) {
    logger.error({ err, actionId: action.id }, "AI app action could not reach the site");
    await recordCall(action, caller, null);
    return refusal(
      action.kind === "read"
        ? "The club website did not answer. Try again in a moment."
        : "The club website did not answer, so it is not known whether this was done. Check before trying again.",
    );
  } finally {
    principal.release();
  }

  await recordCall(action, caller, response.status);

  if (response.status >= 300 && response.status < 400) {
    return refusal("The club website asked for a page in the browser instead of answering. Nothing was returned.");
  }
  if (!/json|text\/plain/i.test(response.contentType) && response.body.length > 0) {
    return refusal("This action returns a page or a file, which an AI app cannot read. Open the club website instead.");
  }

  const cut = response.truncated
    ? `\n[The result was longer than ${MCP_RESULT_MAX_CHARS} characters and was cut. Ask for less at a time.]`
    : "";
  if (response.status >= 400) {
    return refusal(`The club website refused this (HTTP ${response.status}). ${response.body}${cut}`);
  }
  const nextStep = response.truncated ? null : nextStepSentence(action, response.body);
  return {
    isError: false,
    text: `${response.body || "Done."}${cut}${nextStep ? `\n${nextStep}` : ""}`,
  };
}
