export interface XeroErrorHeaders {
  [key: string]: string | number | undefined;
}

export interface XeroErrorShape {
  response?: {
    statusCode?: number;
    headers?: XeroErrorHeaders;
  };
  statusCode?: number;
  status?: number;
  headers?: XeroErrorHeaders;
  body?: {
    Detail?: string;
    Message?: string;
    Title?: string;
  };
  message?: string;
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
      candidate.response?.statusCode ?? candidate.statusCode ?? candidate.status;
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
