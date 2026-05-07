import { describe, expect, it } from "vitest";
import {
  formatRedactedJson,
  redactSensitiveJson,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";

describe("redact-sensitive-json", () => {
  it("redacts sensitive header and token fields in nested payloads", () => {
    expect(
      redactSensitiveJson({
        response: {
          headers: {
            authorization: "Bearer live-token",
            "set-cookie": "session=abc123",
          },
        },
        request: {
          accessToken: "access-token",
          refresh_token: "refresh-token",
        },
      })
    ).toEqual({
      response: {
        headers: {
          authorization: "[REDACTED]",
          "set-cookie": "[REDACTED]",
        },
      },
      request: {
        accessToken: "[REDACTED]",
        refresh_token: "[REDACTED]",
      },
    });
  });

  it("redacts JSON-shaped error text that includes an authorization header", () => {
    expect(
      redactSensitiveText(
        '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"Bearer live-token"}}}}'
      )
    ).toBe(
      '400: {"response":{"statusCode":400,"request":{"headers":{"authorization":"[REDACTED]"}}}}'
    );
  });

  it("redacts stripe token fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment: {
          stripeToken: "st_123",
          stripe_token: "st_456",
        },
      })
    ).toEqual({
      payment: {
        stripeToken: "[REDACTED]",
        stripe_token: "[REDACTED]",
      },
    });
  });

  it("redacts stripe token fields in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"payment":{"stripeToken":"st_123","stripe_token":"st_456"}}'
      )
    ).toBe(
      '500: {"payment":{"stripeToken":"[REDACTED]","stripe_token":"[REDACTED]"}}'
    );
  });

  it("formats redacted JSON for display", () => {
    expect(
      formatRedactedJson({
        headers: {
          authorization: "Bearer live-token",
        },
      })
    ).toContain('"authorization": "[REDACTED]"');
  });
});
