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
  "email",
  "phone",
  "phonenumber",
  "mobilephone",
  "paymentmethod",
  "paymentmethodid",
  "charge",
  "chargeid",
  "clientreferenceid",
]);
const SENSITIVE_JSON_KEY_FRAGMENTS = new Set([
  "email",
  "phone",
  "paymentmethod",
  "charge",
  "clientreferenceid",
]);
const SENSITIVE_STRING_VALUE_PATTERNS = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\+?[0-9]{8,15}/,
];

function normalizeJsonKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveJsonKey(key: string) {
  const normalizedKey = normalizeJsonKey(key);

  // Fragment matches may redact noisy keys like emailedAt, which is acceptable to avoid leaking PII or Stripe IDs.
  return (
    SENSITIVE_JSON_KEYS.has(normalizedKey) ||
    Array.from(SENSITIVE_JSON_KEY_FRAGMENTS).some((sensitiveFragment) =>
      normalizedKey.includes(sensitiveFragment)
    )
  );
}

function isSensitiveStringValue(value: string) {
  return SENSITIVE_STRING_VALUE_PATTERNS.some((pattern) => pattern.test(value));
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

  const redactedValue = value
    .replace(
      /("?(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|stripe[_-]?token|email|phone|phone[_-]?number|mobile[_-]?phone|payment[_-]?method(?:[_-]?id)?|charge(?:[_-]?id)?|client[_-]?reference[_-]?id)"?\s*:\s*")([^"]*)"/gi,
      `$1${REDACTED_SECRET}"`
    )
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, `Bearer ${REDACTED_SECRET}`);

  return isSensitiveStringValue(redactedValue) ? REDACTED_SECRET : redactedValue;
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
