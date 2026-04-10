interface XeroErrorHeaders {
  [key: string]: string | number | undefined;
}

interface XeroErrorShape {
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

export interface XeroApiErrorInfo {
  handled: boolean;
  status: number;
  message: string;
}

function getStringifiedError(error: unknown): string {
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getStatusCode(error: unknown): number | undefined {
  const maybeError = error as XeroErrorShape;
  const statusCode = maybeError?.response?.statusCode ?? maybeError?.statusCode ?? maybeError?.status;
  if (typeof statusCode === "number") {
    return statusCode;
  }

  const stringified = getStringifiedError(error);
  const match = stringified.match(/"statusCode":(\d{3})/);
  if (match) {
    return Number(match[1]);
  }

  return undefined;
}

function getHeader(error: unknown, headerName: string): string | undefined {
  const maybeError = error as XeroErrorShape;
  const headers = maybeError?.response?.headers ?? maybeError?.headers;

  if (headers) {
    const target = headerName.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target && value !== undefined) {
        return String(value);
      }
    }
  }

  const stringified = getStringifiedError(error);
  const match = stringified.match(new RegExp(`"${headerName}":"([^"]+)"`, "i"));
  return match?.[1];
}

function getFallbackMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const maybeError = error as XeroErrorShape;
    const detail = maybeError.body?.Detail ?? maybeError.body?.Message ?? maybeError.body?.Title;
    if (detail) {
      return detail;
    }
    if (maybeError.message) {
      return maybeError.message;
    }
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  return fallbackMessage;
}

export function getXeroApiErrorInfo(
  error: unknown,
  fallbackMessage: string
): XeroApiErrorInfo {
  const statusCode = getStatusCode(error);
  const rateLimitProblem = getHeader(error, "x-rate-limit-problem");
  const isDailyLimit =
    (error instanceof Error && error.name === "XeroDailyLimitError") ||
    (statusCode === 429 && rateLimitProblem === "day");

  if (isDailyLimit) {
    return {
      handled: true,
      status: 429,
      message: "Xero daily API limit reached. Please try again tomorrow.",
    };
  }

  if (statusCode === 429) {
    return {
      handled: true,
      status: 429,
      message: "Xero rate limit hit. Please wait a moment and try again.",
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      handled: true,
      status: 401,
      message: "Xero connection expired. Please reconnect Xero from the admin panel.",
    };
  }

  return {
    handled: false,
    status: 500,
    message: getFallbackMessage(error, fallbackMessage),
  };
}
