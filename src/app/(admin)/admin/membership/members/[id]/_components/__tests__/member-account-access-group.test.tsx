// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemberAccountAccessGroup } from "../member-account-access-group";
import type { MemberGroupEditState } from "../../_hooks/use-member-group-edit";
import type { useInheritEmailSearch } from "../../_hooks/use-inherit-email-search";
import type { MemberDetail } from "../../_types";
import type { MemberAccountEditForm } from "@/lib/admin-member-edit-groups";

// Components resolve role options via this hook (a fetch in the browser);
// tests use the static fallback options, which mirror the seeded defaults.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

// Radix Select does not open in jsdom; a native select keeps value binding
// and onValueChange semantics testable.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <select
      aria-label="User Type"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    disabled,
    children,
  }: {
    value: string;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

const inheritEmailStub = {
  search: "",
  setSearch: vi.fn(),
  results: [],
  error: "",
  searching: false,
  selected: null,
  select: vi.fn(),
  clear: vi.fn(),
} as unknown as ReturnType<typeof useInheritEmailSearch>;

function buildMember(overrides: Partial<MemberDetail> = {}): MemberDetail {
  return {
    id: "member-1",
    firstName: "Alice",
    lastName: "Summit",
    email: "alice@example.test",
    accessRoles: ["USER"],
    canLogin: true,
    active: true,
    forcePasswordChange: false,
    requiresInduction: false,
    inheritEmailFromId: null,
    inheritEmailFrom: null,
    role: "USER",
    financeAccessLevel: "NONE",
    ...overrides,
  } as unknown as MemberDetail;
}

function buildForm(member: MemberDetail): MemberAccountEditForm {
  return {
    canLogin: member.canLogin,
    active: member.active,
    forcePasswordChange: member.forcePasswordChange,
    requiresInduction: member.requiresInduction,
    inheritEmailFromId: member.inheritEmailFromId,
    accessRoles: [...member.accessRoles],
    role: member.role,
    financeAccessLevel: member.financeAccessLevel,
  };
}

function Harness({
  member,
  editing = true,
  isSelf = false,
  actorIsFullAdmin = true,
  canEdit = true,
}: {
  member: MemberDetail;
  editing?: boolean;
  isSelf?: boolean;
  actorIsFullAdmin?: boolean;
  canEdit?: boolean;
}) {
  const [form, setForm] = useState<MemberAccountEditForm | null>(
    editing ? buildForm(member) : null,
  );
  const edit: MemberGroupEditState<MemberAccountEditForm> = {
    editing,
    form,
    saving: false,
    error: "",
    errorRef: { current: null },
    startEdit: () => {},
    cancelEdit: () => {},
    updateForm: (updater) =>
      setForm((current) => (current === null ? current : updater(current))),
    save: async () => {},
  };
  return (
    <>
      <MemberAccountAccessGroup
        member={member}
        isSelf={isSelf}
        actorIsFullAdmin={actorIsFullAdmin}
        memberLifecycleLocked={false}
        edit={edit}
        inheritEmail={inheritEmailStub}
        canEdit={canEdit}
      />
      <div data-testid="tokens">{form?.accessRoles.join(",") ?? ""}</div>
    </>
  );
}

const tokens = () => screen.getByTestId("tokens").textContent;
const typeSelect = () =>
  screen.getByRole("combobox", { name: "User Type" }) as HTMLSelectElement;

describe("MemberAccountAccessGroup view-only gating (#1997, membership)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("disables the Edit button for a view-only admin (canEdit=false)", () => {
    render(<Harness member={buildMember()} editing={false} canEdit={false} />);
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeDisabled();
  });

  it("enables the Edit button for an edit-capable admin (canEdit=true)", () => {
    render(<Harness member={buildMember()} editing={false} canEdit />);
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeEnabled();
  });
});

describe("MemberAccountAccessGroup user type select (#1439)", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a plain user as User with no role picker or member toggle", () => {
    render(<Harness member={buildMember()} />);

    expect(typeSelect().value).toBe("user");
    expect(screen.queryByText("Access Roles")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Also a club member")).not.toBeInTheDocument();
  });

  it("reveals the picker with a default-on member toggle when Admin is selected", () => {
    render(<Harness member={buildMember()} />);

    fireEvent.change(typeSelect(), { target: { value: "admin" } });

    expect(screen.getByText("Access Roles")).toBeInTheDocument();
    expect(screen.getByLabelText("Also a club member")).toBeChecked();
    expect(tokens()).toBe("USER");
    expect(
      screen.getByText(/No admin roles are ticked yet/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /^Full Admin/ }));

    expect(tokens()).toBe("USER,ADMIN");
    expect(
      screen.queryByText(/No admin roles are ticked yet/),
    ).not.toBeInTheDocument();
  });

  it("excludes User, Organisation, and Lodge from the admin role picker", () => {
    render(
      <Harness member={buildMember({ accessRoles: ["USER", "ADMIN"] })} />,
    );

    expect(typeSelect().value).toBe("admin");
    expect(
      screen.queryByRole("checkbox", { name: /^User/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /^Organisation/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /^Lodge/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /^Booking Officer/ }),
    ).toBeInTheDocument();
  });

  it("drops the USER token when 'Also a club member' is unticked", () => {
    render(
      <Harness member={buildMember({ accessRoles: ["USER", "ADMIN"] })} />,
    );

    const alsoMember = screen.getByLabelText("Also a club member");
    expect(alsoMember).toBeChecked();

    fireEvent.click(alsoMember);
    expect(tokens()).toBe("ADMIN");

    fireEvent.click(alsoMember);
    expect(tokens()).toBe("USER,ADMIN");
  });

  it("keeps the Admin section open when the last admin role is unticked", () => {
    render(
      <Harness member={buildMember({ accessRoles: ["USER", "ADMIN"] })} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /^Full Admin/ }));

    expect(tokens()).toBe("USER");
    expect(typeSelect().value).toBe("admin");
    expect(screen.getByText("Access Roles")).toBeInTheDocument();
    expect(
      screen.getByText(/No admin roles are ticked yet/),
    ).toBeInTheDocument();
  });

  it("switching an admin to User drops privileged tokens and hides the picker", () => {
    render(
      <Harness
        member={buildMember({
          accessRoles: ["USER", "ADMIN", "FINANCE_ADMIN"],
        })}
      />,
    );

    fireEvent.change(typeSelect(), { target: { value: "user" } });

    expect(tokens()).toBe("USER");
    expect(screen.queryByText("Access Roles")).not.toBeInTheDocument();

    // Round trip back to Admin restores the stored privileged roles.
    fireEvent.change(typeSelect(), { target: { value: "admin" } });
    expect(tokens()).toBe("USER,ADMIN,FINANCE_ADMIN");
  });

  it("classifies organisations and drops ORG when reclassified as Admin", () => {
    render(<Harness member={buildMember({ accessRoles: ["ORG"] })} />);

    expect(typeSelect().value).toBe("organisation");

    fireEvent.change(typeSelect(), { target: { value: "admin" } });

    expect(tokens()).toBe("USER");
    expect(screen.getByLabelText("Also a club member")).toBeChecked();
  });

  it("disables the Admin option for scoped admins but allows User/Org changes", () => {
    render(<Harness member={buildMember()} actorIsFullAdmin={false} />);

    expect(typeSelect()).not.toBeDisabled();
    expect(
      screen.getByRole("option", { name: "Admin" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Only a Full Admin can classify a member as an Admin/),
    ).toBeInTheDocument();

    fireEvent.change(typeSelect(), { target: { value: "organisation" } });
    expect(tokens()).toBe("ORG");
  });

  it("locks the select for scoped admins when the member holds a privileged role", () => {
    render(
      <Harness
        member={buildMember({ accessRoles: ["USER", "ADMIN"] })}
        actorIsFullAdmin={false}
      />,
    );

    expect(typeSelect()).toBeDisabled();
    // The picker inside the Admin section explains the lock.
    expect(
      screen.getByText(/Only a Full Admin can change this member's access roles/),
    ).toBeInTheDocument();
  });

  it("locks the select for scoped admins on dormant legacy privilege", () => {
    render(
      <Harness
        member={buildMember({ accessRoles: ["USER"], role: "ADMIN" })}
        actorIsFullAdmin={false}
      />,
    );

    expect(typeSelect()).toBeDisabled();
    expect(
      screen.getByText(/dormant privileged legacy role/),
    ).toBeInTheDocument();
  });

  it("shows lodge kiosk accounts as a read-only type with no select", () => {
    render(<Harness member={buildMember({ accessRoles: ["LODGE"] })} />);

    expect(screen.getByText("Lodge (kiosk account)")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Access Roles")).not.toBeInTheDocument();
  });

  it("disables the select when editing your own account", () => {
    render(<Harness member={buildMember()} isSelf />);

    expect(typeSelect()).toBeDisabled();
    expect(
      screen.getByText("You cannot change your own access roles."),
    ).toBeInTheDocument();
  });

  it("restores stored roles, not USER, when login is toggled back on", () => {
    render(<Harness member={buildMember({ accessRoles: ["ORG"] })} />);

    const canLogin = screen.getByLabelText(/Can Login/);

    fireEvent.click(canLogin);
    expect(tokens()).toBe("");
    expect(typeSelect()).toBeDisabled();
    expect(
      screen.getByText("Access roles only apply to login-enabled records."),
    ).toBeInTheDocument();

    fireEvent.click(canLogin);
    expect(tokens()).toBe("ORG");
    expect(typeSelect().value).toBe("organisation");
  });

  it("renders the derived user type in view mode", () => {
    render(
      <Harness
        member={buildMember({ accessRoles: ["USER", "ADMIN"] })}
        editing={false}
      />,
    );

    expect(screen.getByText("User Type")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    // Role badges stay alongside the derived type.
    expect(screen.getByText("Full Admin")).toBeInTheDocument();
  });
});
