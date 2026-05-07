import pino from "pino";
import { redactSensitiveJson } from "@/lib/redact-sensitive-json";

const isDev = process.env.NODE_ENV === "development";

function buildPinoFormatters() {
  return {
    level(label: string) {
      return { level: label };
    },
    log(object: Record<string, unknown>) {
      return redactSensitiveJson(object) as Record<string, unknown>;
    },
  };
}

const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? "debug" : "info"),
  redact: {
    paths: [
      "authorization",
      "cookie",
      "set-cookie",
      "access_token",
      "refresh_token",
      "stripeToken",
      "stripe_token",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    err(value: unknown) {
      return redactSensitiveJson(value);
    },
  },
  ...(isDev
    ? {
        transport: {
          target: "pino/file",
          options: { destination: 1 },
        },
        formatters: buildPinoFormatters(),
      }
    : {
        formatters: buildPinoFormatters(),
      }),
});

export default logger;
