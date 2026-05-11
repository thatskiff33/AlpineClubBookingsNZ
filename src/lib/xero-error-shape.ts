export interface XeroErrorHeaders {
  [key: string]: string | number | undefined;
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
    const match = value.match(new RegExp(`"${headerName}":"([^"]+)"`, "i"));
    if (match) {
      return match[1];
    }
  }

  return undefined;
}
