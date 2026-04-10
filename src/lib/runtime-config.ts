function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getAuthSecret(): string | undefined {
  return readEnv("AUTH_SECRET") ?? readEnv("NEXTAUTH_SECRET");
}

export function getAuthTrustHost(): boolean {
  const raw = readEnv("AUTH_TRUST_HOST");
  return raw === "true";
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function getRuntimeConfigIssues(): string[] {
  const issues: string[] = [];

  if (!getAuthSecret()) {
    issues.push("AUTH_SECRET or NEXTAUTH_SECRET is required");
  }

  const nextAuthUrl = readEnv("NEXTAUTH_URL");
  if (!nextAuthUrl) {
    issues.push("NEXTAUTH_URL is required");
  } else if (!isValidHttpUrl(nextAuthUrl)) {
    issues.push("NEXTAUTH_URL must be a valid http(s) URL");
  }

  if (!readEnv("CRON_SECRET")) {
    issues.push("CRON_SECRET is required");
  }

  const authTrustHost = readEnv("AUTH_TRUST_HOST");
  if (
    authTrustHost !== undefined &&
    authTrustHost !== "true" &&
    authTrustHost !== "false"
  ) {
    issues.push("AUTH_TRUST_HOST must be true or false");
  }

  return issues;
}

export function getRuntimeConfigCheck(): {
  status: "ok" | "error";
  latencyMs: number;
  error?: string;
} {
  const start = Date.now();
  const issues = getRuntimeConfigIssues();

  if (issues.length === 0) {
    return {
      status: "ok",
      latencyMs: Date.now() - start,
    };
  }

  return {
    status: "error",
    latencyMs: Date.now() - start,
    error: issues.join("; "),
  };
}
