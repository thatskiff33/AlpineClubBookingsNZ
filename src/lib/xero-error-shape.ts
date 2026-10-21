import { CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE } from "@/lib/xero-credit-note-spent-outside-app";

interface XeroErrorHeaders {
  [key: string]: string | number | undefined;
}

// Escape regex metacharacters so a header name can never form a pathological
// pattern. All call sites pass fixed internal literals, so this is defensive.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface XeroErrorShape {
  response?: {
    statusCode?: number;
    headers?: XeroErrorHeaders;
    body?: XeroErrorBody;
  };
  statusCode?: number;
  status?: number;
  headers?: XeroErrorHeaders;
  body?: XeroErrorBody;
  message?: string;
}

interface XeroErrorBody {
  Detail?: string;
  Message?: string;
  Title?: string;
  Status?: number;
  Instance?: string;
}

function getStringCandidates(error: unknown): string[] {
  const values: string[] = [];

  if (error instanceof Error && error.message.trim()) {
    values.push(error.message);
  }

  if (typeof error === "string" && error.trim()) {
    values.push(error);
  }

  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") {
      values.push(json);
    }
  } catch {
    // Ignore non-serializable values.
  }

  return values;
}

function parseJsonCandidate(value: string): XeroErrorShape | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as XeroErrorShape;
    }
  } catch {
    // Ignore invalid JSON.
  }

  return null;
}

function getErrorCandidates(error: unknown): XeroErrorShape[] {
  const candidates: XeroErrorShape[] = [];

  if (error && typeof error === "object") {
    candidates.push(error as XeroErrorShape);
  }

  for (const value of getStringCandidates(error)) {
    const parsed = parseJsonCandidate(value);
    if (parsed) {
      candidates.push(parsed);
    }
  }

  return candidates;
}

export function getXeroErrorStatusCode(error: unknown): number | undefined {
  for (const candidate of getErrorCandidates(error)) {
    const statusCode =
      candidate.response?.statusCode ??
      candidate.statusCode ??
      candidate.status ??
      candidate.body?.Status ??
      candidate.response?.body?.Status;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  for (const value of getStringCandidates(error)) {
    const match = value.match(/"statusCode":(\d{3})/);
    if (match) {
      return Number(match[1]);
    }
  }

  return undefined;
}

/**
 * #3836 (M2), #3924 round 15: did Xero REFUSE this operation - a FAILED or
 * PARTIAL row whose `lastErrorCode` (the status `failXeroSyncOperation` reads
 * with `getXeroErrorStatusCode`) is a 4xx other than 408 (timeout) or 429
 * (rate limit), which are transient, or the named code of a refusal Xero
 * explained (#4218: CREDIT_NOTE_SPENT_OUTSIDE_APP)? A refused write created nothing, and
 * re-running it changes nothing until someone fixes the cause in Xero.
 */
export function xeroRefusedOperation(operation: { status: string; lastErrorCode: string | null }): boolean {
  const code = operation.lastErrorCode ?? "";
  if (!["FAILED", "PARTIAL"].includes(operation.status)) return false;
  // #4218: Xero's 400 over-allocation refusal is recorded under its own name, and
  // is still a refusal: nothing was created.
  if (code === CREDIT_NOTE_SPENT_OUTSIDE_APP_CODE) return true;
  return /^4\d\d$/.test(code) && code !== "408" && code !== "429";
}

export function getXeroErrorBodyMessage(error: unknown): string | undefined {
  for (const candidate of getErrorCandidates(error)) {
    const responseBody = candidate.response?.body;
    const responseMessage =
      responseBody?.Detail ?? responseBody?.Message ?? responseBody?.Title;
    if (responseMessage) {
      return responseMessage;
    }

    const body = candidate.body;
    const message = body?.Detail ?? body?.Message ?? body?.Title;
    if (message) {
      return message;
    }
  }

  return undefined;
}

export function getXeroErrorHeader(
  error: unknown,
  headerName: string
): string | undefined {
  const target = headerName.toLowerCase();

  for (const candidate of getErrorCandidates(error)) {
    const headers = candidate.response?.headers ?? candidate.headers;
    if (!headers) continue;

    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target && value !== undefined) {
        return String(value);
      }
    }
  }

  for (const value of getStringCandidates(error)) {
    // headerName is always an internal literal header key; escaped above so no
    // ReDoS surface exists despite the dynamic RegExp.
    const pattern = new RegExp(`"${escapeRegExp(headerName)}":"([^"]+)"`, "i");
    const match = value.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return undefined;
}
