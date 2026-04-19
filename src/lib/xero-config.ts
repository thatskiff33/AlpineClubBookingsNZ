function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidHexEncryptionKey(value: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(value);
}

const XERO_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.payments",
  "accounting.settings.read",
  "offline_access",
] as const;

const DEFAULT_OPERATIONAL_XERO_REDIRECT_URI =
  "http://localhost:3000/api/admin/xero/callback";
const DEFAULT_FINANCE_XERO_REDIRECT_URI =
  "http://localhost:3000/api/finance/xero/callback";

interface XeroClientConfigOptions {
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectUriEnv: string;
  defaultRedirectUri: string;
}

function buildXeroClientConfig({
  clientIdEnv,
  clientSecretEnv,
  redirectUriEnv,
  defaultRedirectUri,
}: XeroClientConfigOptions) {
  return {
    clientId: readEnv(clientIdEnv) ?? "",
    clientSecret: readEnv(clientSecretEnv) ?? "",
    redirectUris: [readEnv(redirectUriEnv) ?? defaultRedirectUri],
    scopes: [...XERO_OAUTH_SCOPES],
  };
}

export function getOperationalXeroConfig() {
  return buildXeroClientConfig({
    clientIdEnv: "XERO_CLIENT_ID",
    clientSecretEnv: "XERO_CLIENT_SECRET",
    redirectUriEnv: "XERO_REDIRECT_URI",
    defaultRedirectUri: DEFAULT_OPERATIONAL_XERO_REDIRECT_URI,
  });
}

export function getOperationalXeroEncryptionKey(): string | undefined {
  return readEnv("XERO_ENCRYPTION_KEY");
}

export function getFinanceXeroConfig() {
  return buildXeroClientConfig({
    clientIdEnv: "FINANCE_XERO_CLIENT_ID",
    clientSecretEnv: "FINANCE_XERO_CLIENT_SECRET",
    redirectUriEnv: "FINANCE_XERO_REDIRECT_URI",
    defaultRedirectUri: DEFAULT_FINANCE_XERO_REDIRECT_URI,
  });
}

export function getFinanceXeroConfigIssues(): string[] {
  const issues: string[] = [];

  if (!readEnv("FINANCE_XERO_CLIENT_ID")) {
    issues.push("FINANCE_XERO_CLIENT_ID is required");
  }

  if (!readEnv("FINANCE_XERO_CLIENT_SECRET")) {
    issues.push("FINANCE_XERO_CLIENT_SECRET is required");
  }

  const redirectUri = readEnv("FINANCE_XERO_REDIRECT_URI");
  if (redirectUri && !isValidHttpUrl(redirectUri)) {
    issues.push("FINANCE_XERO_REDIRECT_URI must be a valid http(s) URL");
  }

  return issues;
}

export function hasFinanceXeroConfig(): boolean {
  return getFinanceXeroConfigIssues().length === 0;
}

export function getFinanceXeroEncryptionKey(): string | undefined {
  return readEnv("FINANCE_XERO_ENCRYPTION_KEY");
}

export function getFinanceXeroTokenStorageIssues(): string[] {
  const issues: string[] = [];
  const encryptionKey = getFinanceXeroEncryptionKey();

  if (!encryptionKey) {
    issues.push("FINANCE_XERO_ENCRYPTION_KEY is required");
    return issues;
  }

  if (!isValidHexEncryptionKey(encryptionKey)) {
    issues.push("FINANCE_XERO_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }

  return issues;
}

export function hasFinanceXeroTokenStorageConfig(): boolean {
  return getFinanceXeroTokenStorageIssues().length === 0;
}
