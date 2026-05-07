const REDACTED_SECRET = "[REDACTED]";
const SENSITIVE_JSON_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "apikey",
  "password",
  "stripetoken",
]);

function normalizeJsonKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveJsonKey(key: string) {
  return SENSITIVE_JSON_KEYS.has(normalizeJsonKey(key));
}

function redactJsonStringCandidate(value: string): string | null {
  const trimmed = value.trim();
  const firstBraceIndex = trimmed.search(/[{\[]/);

  if (firstBraceIndex === -1) {
    return null;
  }

  const prefix = trimmed.slice(0, firstBraceIndex);
  const jsonCandidate = trimmed.slice(firstBraceIndex);

  try {
    return `${prefix}${JSON.stringify(redactSensitiveJson(JSON.parse(jsonCandidate)))}`;
  } catch {
    return null;
  }
}

export function redactSensitiveText(value: string): string {
  const redactedJsonCandidate = redactJsonStringCandidate(value);
  if (redactedJsonCandidate) {
    return redactedJsonCandidate;
  }

  return value
    .replace(
      /("?(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token)"?\s*:\s*")([^"]*)"/gi,
      `$1${REDACTED_SECRET}"`
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, `Bearer ${REDACTED_SECRET}`);
}

export function redactSensitiveJson(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveText(value.message),
      stack: value.stack ? redactSensitiveText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveJson(entry));
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    result[key] = isSensitiveJsonKey(key)
      ? REDACTED_SECRET
      : redactSensitiveJson(entryValue);
  }

  return result;
}

export function formatRedactedJson(value: unknown): string {
  return JSON.stringify(redactSensitiveJson(value ?? null), null, 2);
}
