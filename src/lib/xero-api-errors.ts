import {
  XeroErrorShape,
  getXeroErrorHeader,
  getXeroErrorStatusCode,
} from "@/lib/xero-error-shape";

export interface XeroApiErrorInfo {
  handled: boolean;
  status: number;
  message: string;
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
  const statusCode = getXeroErrorStatusCode(error);
  const rateLimitProblem = getXeroErrorHeader(error, "x-rate-limit-problem");
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
