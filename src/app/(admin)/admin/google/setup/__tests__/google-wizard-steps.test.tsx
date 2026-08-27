// @vitest-environment jsdom

import { render, screen, cleanup } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialsStep, VerifyStep } from "../google-wizard-steps";
import type { GoogleWizardContext } from "../use-google-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";
import { ADMIN_FULL_ADMIN_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";

// The verify step reads `?googleVerifyError=1` (set by the signIn callback on a
// session-mismatch verify failure, src/lib/auth.ts) to surface a clear error.
const searchMock = vi.hoisted(() => ({ params: "" as string }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchMock.params),
}));

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

function makeContext(
  overrides: Partial<GoogleWizardContext> = {},
): GoogleWizardContext {
  return {
    redirectUri: "https://example.test/api/auth/callback/google",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: true, setAt: null },
      client_secret: { set: true, setAt: null },
    },
    isFullAdmin: true,
    needsReentry: false,
    verified: false,
    ...overrides,
  };
}

const helpers: WizardStepHelpers = {
  canEdit: true,
  refresh: vi.fn(),
  goNext: vi.fn(),
  isVerified: false,
  optional: false,
  acknowledged: false,
  skip: vi.fn(),
  // Required, and typed as the literal `true` (#2324): the shell always renders
  // the view-only banner above a step, so a step body is always covered when it
  // is the shell rendering it.
  ancestorRendersViewOnlyBanner: true,
};

const ERROR_RE = /make sure you.re signed in as the same Full Admin/i;
const BOUNCE_RE = /bounce you to the login page with an error/i;

describe("VerifyStep verify-failure feedback (#2087)", () => {
  beforeEach(() => {
    searchMock.params = "";
  });
  afterEach(() => cleanup());

  it("renders the mismatch error Alert when googleVerifyError=1 and not verified", () => {
    searchMock.params = "googleVerifyError=1";
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.getByText(ERROR_RE)).toBeTruthy();
  });

  it("shows NO error Alert when the param is absent", () => {
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(ERROR_RE)).toBeNull();
  });

  it("suppresses the error Alert once the round-trip has verified", () => {
    // A stale ?googleVerifyError=1 must not contradict a now-verified context.
    searchMock.params = "googleVerifyError=1";
    render(
      <VerifyStep context={makeContext({ verified: true })} helpers={helpers} />,
    );
    expect(screen.queryByText(ERROR_RE)).toBeNull();
    expect(screen.getByText(/round-trip completed successfully/i)).toBeTruthy();
  });

  it("amber guidance warns that wrong credentials/redirect URI bounce to the login page", () => {
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.getByText(BOUNCE_RE)).toBeTruthy();
  });
});

// The notice is `Only a <strong>Full Admin</strong> can run verification.`, so
// the sentence spans three nodes; match the tail, which is one text node.
const FULL_ADMIN_NOTICE_RE = /can run verification/i;

describe("VerifyStep Full-Admin notice is tri-state (#2324)", () => {
  /*
    `isFullAdmin` is derived from `useSession()`, not from the wizard's own
    fetch, and the shell renders a step as soon as its CONTEXT loads. Reading an
    unresolved session as `false` therefore showed "Only a Full Admin can run
    verification" and then removed it again for an actual Full Admin. The flag is
    tri-state, so `undefined` must render neutrally: no notice, and the action
    still disabled (never an enabled control offered to someone who may not have
    the permission).
  */
  beforeEach(() => {
    searchMock.params = "";
  });
  afterEach(() => cleanup());

  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <VerifyStep context={makeContext({ isFullAdmin: false })} helpers={helpers} />,
    );
    expect(screen.getByText(FULL_ADMIN_NOTICE_RE)).toBeTruthy();
  });

  it("shows no notice while the session is still resolving", () => {
    render(
      <VerifyStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    expect(screen.queryByText(FULL_ADMIN_NOTICE_RE)).toBeNull();
  });

  it("keeps the verify action disabled while the session is still resolving", () => {
    render(
      <VerifyStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    const verify = screen.getByRole("button", {
      name: /Verify with Google/i,
    }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    // …and neutrally: no read-only reason is exposed before we know.
    expect(verify.getAttribute("title")).toBeNull();
  });

  it("shows no notice and enables verify for a resolved Full Admin", () => {
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(FULL_ADMIN_NOTICE_RE)).toBeNull();
    const verify = screen.getByRole("button", {
      name: /Verify with Google/i,
    }) as HTMLButtonElement;
    expect(verify.disabled).toBe(false);
  });
});

// Same three nodes, same tail-matching reason as above.
const CREDENTIALS_NOTICE_RE = /can enter or replace Google/i;

describe("CredentialsStep Full-Admin notice is tri-state (#2324)", () => {
  // The sibling of the VerifyStep block above: the same `isFullAdmin` flag gates
  // this step's notice, so the same resolving window could flash it.
  afterEach(() => cleanup());

  it("shows the notice only once the session says NOT a Full Admin", () => {
    render(
      <CredentialsStep
        context={makeContext({ isFullAdmin: false })}
        helpers={helpers}
      />,
    );
    expect(screen.getByText(CREDENTIALS_NOTICE_RE)).toBeTruthy();
    // …and the button states the same narrower permission, because an admin
    // with finance edit but no Full Admin meets no banner at all.
    expect(
      screen
        .getByRole("button", { name: /^(Save|Replace) credentials$/i })
        .getAttribute("title"),
    ).toBe(ADMIN_FULL_ADMIN_ONLY_ACTION_REASON);
  });

  it("shows no notice, and no reason, while the session is still resolving", () => {
    render(
      <CredentialsStep
        context={makeContext({ isFullAdmin: undefined })}
        helpers={helpers}
      />,
    );
    expect(screen.queryByText(CREDENTIALS_NOTICE_RE)).toBeNull();
    const save = screen.getByRole("button", {
      name: /^(Save|Replace) credentials$/i,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.getAttribute("title")).toBeNull();
    expect(
      (screen.getByLabelText(/Client ID/i) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it("shows no notice for a resolved Full Admin", () => {
    render(<CredentialsStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(CREDENTIALS_NOTICE_RE)).toBeNull();
    expect(
      (screen.getByLabelText(/Client ID/i) as HTMLInputElement).disabled,
    ).toBe(false);
  });
});
