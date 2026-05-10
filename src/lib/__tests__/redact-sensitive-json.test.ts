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
          password: "hunter2",
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
        password: "[REDACTED]",
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

  it("redacts email and phone fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        email: "a@b.com",
        phone: "+64211234567",
      })
    ).toEqual({
      email: "[REDACTED]",
      phone: "[REDACTED]",
    });
  });

  it("redacts email values on generic fields", () => {
    expect(
      redactSensitiveJson({
        to: "a@b.com",
      })
    ).toEqual({
      to: "[REDACTED]",
    });
  });

  it("redacts Stripe payment method fields in structured payloads", () => {
    expect(
      redactSensitiveJson({
        payment_method: "pm_1ABC",
      })
    ).toEqual({
      payment_method: "[REDACTED]",
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

  it("redacts newly sensitive keys in JSON-shaped text", () => {
    expect(
      redactSensitiveText(
        '500: {"email":"a@b.com","phone":"+64211234567","payment_method":"pm_1ABC","chargeId":"ch_1ABC"}'
      )
    ).toBe(
      '500: {"email":"[REDACTED]","phone":"[REDACTED]","payment_method":"[REDACTED]","chargeId":"[REDACTED]"}'
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
