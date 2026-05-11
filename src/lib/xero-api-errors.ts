import {
  XeroErrorShape,
  getXeroErrorBodyMessage,
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";

export interface XeroApiErrorInfo {
  handled: boolean;
  status: number;
  message: string;
}

function getFallbackMessage(error: unknown, fallbackMessage: string): string {
  const bodyMessage = getXeroErrorBodyMessage(error);
  if (bodyMessage) {
    return bodyMessage;
  }

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
  const statusCode = getXeroErrorStatusCode(error);
  const rateLimitProblem = getXeroErrorHeader(error, "x-rate-limit-problem");
  const isDailyLimit =
    (error instanceof Error && error.name === "XeroDailyLimitError") ||
    (statusCode === 429 && rateLimitProblem === "day");
  const isTransientOutage =
    error instanceof Error && error.name === "XeroTransientOutageError";

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

  if (isTransientOutage) {
    return {
      handled: true,
      status: 503,
      message: getFallbackMessage(error, "Xero is temporarily unavailable. Please try again shortly."),
    };
  }

  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    const correlationId = getXeroErrorHeader(error, "xero-correlation-id");
    const retryMessage =
      `Xero is temporarily unavailable (HTTP ${statusCode}). ` +
      `${getFallbackMessage(error, fallbackMessage)} ` +
      "Please try again in a few minutes." +
      (correlationId ? ` Xero correlation ID: ${correlationId}.` : "");

    return {
      handled: false,
      status: 502,
      message: retryMessage,
    };
  }

  return {
    handled: false,
    status: 500,
    message: getFallbackMessage(error, fallbackMessage),
  };
}
