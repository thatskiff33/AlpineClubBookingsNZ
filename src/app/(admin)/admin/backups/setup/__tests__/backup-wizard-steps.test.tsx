// @vitest-environment jsdom

import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CredentialsStep,
  DestinationStep,
  OperationalStep,
  VerificationStep,
} from "../backup-wizard-steps";
import type { BackupWizardContext } from "../use-backup-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";

// next/link needs no router in these unit renders — a plain anchor is enough.
vi.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

function makeContext(
  overrides: Partial<BackupWizardContext> = {},
): BackupWizardContext {
  return {
    legacyEnvVars: [],
    legacyEnvUnmigrated: false,
    accessKeyIdSet: false,
    secretAccessKeySet: false,
    bucket: null,
    region: "ap-southeast-2",
    enabled: false,
    retentionDays: 7,
    durable: false,
    needsReentry: false,
    canManageDestination: true,
    running: false,
    latestRun: null,
    verified: false,
    verifiedS3Key: null,
    verifiedSizeBytes: null,
    latestRunFailed: false,
    latestRunError: null,
    ...overrides,
  };
}

function makeHelpers(
  overrides: Partial<WizardStepHelpers> = {},
): WizardStepHelpers {
  return {
    canEdit: true,
    refresh: vi.fn(),
    goNext: vi.fn(),
    isVerified: false,
    optional: false,
    acknowledged: false,
    skip: vi.fn(),
    // Required, and typed as the literal `true` (#2324): the shell always
    // renders the view-only banner above a step, so a step body is always
    // covered when it is the shell rendering it.
    ancestorRendersViewOnlyBanner: true,
    ...overrides,
  };
}

function mockFetchOk(status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CredentialsStep (#2227)", () => {
  it("shows the legacy migration callout naming the values to re-enter", () => {
    render(
      <CredentialsStep
        context={makeContext({
          legacyEnvVars: ["BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID"],
        })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.getByText(/Legacy backup environment variables/i),
    ).toBeTruthy();
    // Names the config fields (not any value) and lists the detected vars.
    expect(screen.getByText(/Re-enter these values as you go/i)).toBeTruthy();
    expect(
      screen.getByText(/BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID/),
    ).toBeTruthy();
  });

  it("shows no migration callout when there are no legacy vars", () => {
    render(<CredentialsStep context={makeContext()} helpers={makeHelpers()} />);
    expect(screen.queryByText(/Legacy backup environment variables/i)).toBeNull();
  });

  it("blocks writing and explains when the viewer is not Full Admin", () => {
    render(
      <CredentialsStep
        context={makeContext({ canManageDestination: false })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByText(/can enter or replace the S3/i)).toBeTruthy();
    expect(
      (screen.getByLabelText(/S3 access key ID/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("saves entered credentials through the shared credentials route", async () => {
    const fetchMock = mockFetchOk();
    const helpers = makeHelpers();
    render(<CredentialsStep context={makeContext()} helpers={helpers} />);

    fireEvent.change(screen.getByLabelText(/S3 access key ID/i), {
      target: { value: "AKIA-test" },
    });
    fireEvent.change(screen.getByLabelText(/S3 secret access key/i), {
      target: { value: "s3cr3t" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save credentials/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/integrations/credentials");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ provider: "backup", key: "access_key_id" });
    await waitFor(() => expect(helpers.refresh).toHaveBeenCalled());
  });

  it("surfaces the needs-reentry alert", () => {
    render(
      <CredentialsStep
        context={makeContext({ needsReentry: true })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByText(/can no longer be read/i)).toBeTruthy();
  });
});

describe("DestinationStep (#2227)", () => {
  it("saves bucket and region through the backups config route", async () => {
    const fetchMock = mockFetchOk();
    render(<DestinationStep context={makeContext()} helpers={makeHelpers()} />);

    fireEvent.change(screen.getByLabelText(/Bucket/i), {
      target: { value: "my-club-backups" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save destination/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/backups/config");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ bucket: "my-club-backups" });
  });

  it("blocks a non-Full-Admin from editing the destination", () => {
    render(
      <DestinationStep
        context={makeContext({ canManageDestination: false })}
        helpers={makeHelpers()}
      />,
    );
    expect((screen.getByLabelText(/Bucket/i) as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/can change the backup destination/i)).toBeTruthy();
  });
});

describe("OperationalStep (#2227)", () => {
  it("saves the enabled toggle and retention through the config route", async () => {
    const fetchMock = mockFetchOk();
    render(<OperationalStep context={makeContext()} helpers={makeHelpers()} />);

    fireEvent.click(screen.getByLabelText(/Enable nightly database backups/i));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/backups/config");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ enabled: true, retentionDays: 7 });
  });

  it("blocks editing without support edit access", () => {
    render(
      <OperationalStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: false })}
      />,
    );
    expect(
      (
        screen.getByLabelText(
          /Enable nightly database backups/i,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // …and does NOT repeat the reason (#2324): the shell's view-only banner
    // states this exact scope once at the top of the wizard, so the step body
    // no longer carries its own "support edit access is required" sentence.
    expect(screen.queryByText(/Support edit access is required/i)).toBeNull();
  });

  it("shows no view-only sentence while the session is still resolving", () => {
    // The deleted sentence was keyed off `!canWrite`, which is also true for the
    // tri-state resolving window (`canEdit === undefined`) — so it flashed at
    // admins who CAN change these settings. Nothing is stated now; the control
    // still stays disabled, which is the correct neutral (#2065).
    render(
      <OperationalStep
        context={makeContext()}
        helpers={makeHelpers({ canEdit: undefined })}
      />,
    );
    expect(screen.queryByText(/Support edit access is required/i)).toBeNull();
    expect(screen.queryByText(/cannot change them/i)).toBeNull();
    expect(
      (
        screen.getByLabelText(
          /Enable nightly database backups/i,
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });
});

describe("VerificationStep (#2227)", () => {
  it("shows the verified badge with the S3 key and size on success", () => {
    render(
      <VerificationStep
        context={makeContext({
          enabled: true,
          durable: true,
          verified: true,
          verifiedS3Key: "backups/tacbookings-2026.sql.gz",
          verifiedSizeBytes: 1536,
        })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByText(/uploaded to S3 and was read back/i)).toBeTruthy();
    expect(
      screen.getByText(/backups\/tacbookings-2026\.sql\.gz/),
    ).toBeTruthy();
    expect(screen.getByText(/1\.5 KB/)).toBeTruthy();
  });

  it("shows a running state while a backup is in progress", () => {
    render(
      <VerificationStep
        context={makeContext({ enabled: true, durable: true, running: true })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByText(/A backup is running now/i)).toBeTruthy();
  });

  it("shows the failure alert with the run error", () => {
    render(
      <VerificationStep
        context={makeContext({
          enabled: true,
          durable: true,
          latestRunFailed: true,
          latestRunError: "upload denied",
        })}
        helpers={makeHelpers()}
      />,
    );
    expect(screen.getByText(/The last backup run failed/i)).toBeTruthy();
    expect(screen.getByText(/upload denied/)).toBeTruthy();
  });

  it("explains the disabled run when backups are not enabled", () => {
    render(
      <VerificationStep
        context={makeContext({ enabled: false, durable: true })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.getByText(/Enable nightly backups on the previous step first/i),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /run verification backup/i }) as
        HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("explains the disabled run when the destination is not durable", () => {
    render(
      <VerificationStep
        context={makeContext({ enabled: true, durable: false })}
        helpers={makeHelpers()}
      />,
    );
    expect(
      screen.getByText(/Set the S3 credentials and destination/i),
    ).toBeTruthy();
  });

  it("posts to the run endpoint and refreshes when the backup is started", async () => {
    const fetchMock = mockFetchOk(202);
    const helpers = makeHelpers();
    render(
      <VerificationStep
        context={makeContext({ enabled: true, durable: true })}
        helpers={helpers}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /run verification backup/i }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/backups/run");
    await waitFor(() => expect(helpers.refresh).toHaveBeenCalled());
  });
});
