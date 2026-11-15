// The shapes the Setup page reads from /api/admin/setup and the provider test.
export type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
export type ProgressStatus = "open" | "completed" | "skipped";
export type Provider = "stripe" | "smtp" | "sentry" | "xero";

export interface SetupStepCheck {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  required: boolean;
  message: string;
  details: string[];
  href?: string;
  progress: ProgressStatus;
  action?: {
    type: "provider-test";
    provider: Provider;
    label: string;
  };
}

export interface SetupCategory {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

export interface SetupReadiness {
  status: SetupStatus;
  summary: {
    total: number;
    complete: number;
    warning: number;
    blocked: number;
    skipped: number;
  };
  categories: SetupCategory[];
  generatedAt: string;
}

export interface SetupProgressState {
  completedStepIds: string[];
  skippedStepIds: string[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

export interface SetupResponse {
  readiness: SetupReadiness;
  progress: SetupProgressState;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: Provider;
  checkedAt: string;
  message: string;
}
