import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mail transport's own timeouts (#5407 item 34): every transport this app
 * builds carries explicit connection, greeting and socket timeouts, read from
 * three deployment settings with defaults, instead of nodemailer's long ones.
 */

const mocks = vi.hoisted(() => ({
  environmentSafetyFindUnique: vi.fn(),
  createTransport: vi.fn(),
  verify: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: mocks.environmentSafetyFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

import {
  EMAIL_TRANSPORT_TIMEOUT_RANGE_MS,
  EMAIL_TRANSPORT_TIMEOUT_SETTINGS,
  resolveEmailDeliveryConfigFromEnv,
} from "@/lib/email-delivery";
import { verifyEmailTransport } from "@/lib/email/internal";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

const DEFAULTS = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 120_000,
};

const SES_ENV = {
  EMAIL_FROM: "club@club.test",
  USE_AWS_SES: "true",
  AWS_SES_ACCESS_KEY_ID: "key",
  AWS_SES_SECRET_ACCESS_KEY: "secret",
};
const RELAY_ENV = {
  EMAIL_FROM: "club@club.test",
  USE_SMTP_RELAY: "true",
  EMAIL_SERVER_HOST: "smtp.example.org",
  EMAIL_SERVER_PORT: "587",
  EMAIL_SERVER_USER: "relay",
  EMAIL_SERVER_PASSWORD: "secret",
};
const CAPTURE_ENV = {
  ...RELAY_ENV,
  USE_SMTP_RELAY: "false",
  USE_LOCAL_CAPTURE: "true",
  EMAIL_SERVER_HOST: "mailpit",
  EMAIL_SERVER_PORT: "1025",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
  mocks.verify.mockResolvedValue(true);
  mocks.createTransport.mockReturnValue({ verify: mocks.verify });
});

describe("the transport timeouts' one definition", () => {
  it("names each setting, its default and the accepted range once", () => {
    expect(EMAIL_TRANSPORT_TIMEOUT_SETTINGS).toEqual({
      connectionTimeout: { env: "EMAIL_SMTP_CONNECTION_TIMEOUT_MS", defaultMs: DEFAULTS.connectionTimeout },
      greetingTimeout: { env: "EMAIL_SMTP_GREETING_TIMEOUT_MS", defaultMs: DEFAULTS.greetingTimeout },
      socketTimeout: { env: "EMAIL_SMTP_SOCKET_TIMEOUT_MS", defaultMs: DEFAULTS.socketTimeout },
    });
    expect(EMAIL_TRANSPORT_TIMEOUT_RANGE_MS).toEqual({ min: 1_000, max: 600_000 });
  });
});

describe("every transport carries the timeouts (#5407 item 34)", () => {
  it.each([
    ["AWS SES", SES_ENV],
    ["an SMTP relay", RELAY_ENV],
    ["a declared capture mailbox", CAPTURE_ENV],
  ])("applies the defaults to %s when nothing is set", (_label, env) => {
    const config = resolveEmailDeliveryConfigFromEnv(env);
    expect(config.ok).toBe(true);
    expect(config.transportOptions).toMatchObject(DEFAULTS);
    expect(config.warnings.filter((line) => line.includes("_TIMEOUT_MS"))).toEqual([]);
  });

  it("maps each setting to the option nodemailer reads", () => {
    const config = resolveEmailDeliveryConfigFromEnv({
      ...RELAY_ENV,
      EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "10000",
      EMAIL_SMTP_GREETING_TIMEOUT_MS: "15000",
      EMAIL_SMTP_SOCKET_TIMEOUT_MS: "45000",
    });
    expect(config.transportOptions).toMatchObject({
      connectionTimeout: 10_000,
      greetingTimeout: 15_000,
      socketTimeout: 45_000,
    });
  });

  it("accepts both ends of the range", () => {
    const config = resolveEmailDeliveryConfigFromEnv({
      ...SES_ENV,
      EMAIL_SMTP_CONNECTION_TIMEOUT_MS: "1000",
      EMAIL_SMTP_SOCKET_TIMEOUT_MS: "600000",
    });
    expect(config.transportOptions).toMatchObject({ connectionTimeout: 1_000, socketTimeout: 600_000 });
  });

  it.each(["0", "999", "600001", "abc", "1.5", "30s", "-5000", "1e4"])(
    "falls back to the default with a warning, and still sends, for %j",
    (raw) => {
      const config = resolveEmailDeliveryConfigFromEnv({ ...RELAY_ENV, EMAIL_SMTP_SOCKET_TIMEOUT_MS: raw });
      expect(config.ok).toBe(true);
      expect(config.transportOptions).toMatchObject({ socketTimeout: DEFAULTS.socketTimeout });
      expect(config.warnings).toContain(
        "EMAIL_SMTP_SOCKET_TIMEOUT_MS must be a whole number of milliseconds from 1000 to 600000; using the default 120000",
      );
    },
  );

  it("hands the timeouts to the transport it builds", async () => {
    declareEnvironmentRole("production");
    for (const [name, value] of Object.entries({ ...RELAY_ENV, EMAIL_SMTP_GREETING_TIMEOUT_MS: "20000" })) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("USE_AWS_SES", "false");
    vi.stubEnv("USE_LOCAL_CAPTURE", "false");

    await verifyEmailTransport();

    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.org",
        connectionTimeout: DEFAULTS.connectionTimeout,
        greetingTimeout: 20_000,
        socketTimeout: DEFAULTS.socketTimeout,
      }),
    );
  });
});
