import { describe, expect, it } from "vitest";
import { getXeroApiErrorInfo } from "../xero-api-errors";

describe("getXeroApiErrorInfo", () => {
  it("maps XeroDailyLimitError by name to a friendly 429 response", () => {
    const error = new Error("Xero daily API limit reached. Retry after 86400 seconds.");
    error.name = "XeroDailyLimitError";

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 429,
      message: "Xero daily API limit reached. Please try again tomorrow.",
    });
  });

  it("maps raw 429 errors to the short rate-limit message", () => {
    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 429,
            headers: {
              "retry-after": "60",
            },
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 429,
      message: "Xero rate limit hit. Please wait a moment and try again.",
    });
  });

  it("maps 401 and 403 to reconnect guidance", () => {
    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 401,
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 401,
      message: "Xero connection expired. Please reconnect Xero from the admin panel.",
    });

    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 403,
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 401,
      message: "Xero connection expired. Please reconnect Xero from the admin panel.",
    });
  });

  it("falls back to the original error message for unknown failures", () => {
    expect(getXeroApiErrorInfo(new Error("Boom"), "Fallback failure")).toEqual({
      handled: false,
      status: 500,
      message: "Boom",
    });
  });
});
