// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileDetailsCard } from "@/app/(authenticated)/profile/profile-details-card";
import { ProfileForm } from "@/app/(authenticated)/profile/profile-form";

const fetchMock = vi.fn();
const { replaceMock } = vi.hoisted(() => ({
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode;
    href: string;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/components/address-autocomplete", () => ({
  AddressAutocomplete: ({
    addressParams,
    countryCode,
    onAddressSelected,
    onChange,
    value,
    ...props
  }: InputHTMLAttributes<HTMLInputElement> & {
    addressParams?: Record<string, string>;
    countryCode?: string;
    onAddressSelected: unknown;
    onChange: (value: string) => void;
    value: string;
  }) => {
    void addressParams;
    void countryCode;
    void onAddressSelected;

    return (
      <input
        {...props}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    );
  },
}));

const member = {
  id: "member-1",
  firstName: "Alice",
  lastName: "Smith",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
  dateOfBirth: "1990-01-15",
  streetAddressLine1: "123 Main St",
  streetAddressLine2: "",
  streetCity: "Tokoroa",
  streetRegion: "Waikato",
  streetPostalCode: "3420",
  streetCountry: "NZ",
  postalAddressLine1: "123 Main St",
  postalAddressLine2: "",
  postalCity: "Tokoroa",
  postalRegion: "Waikato",
  postalPostalCode: "3420",
  postalCountry: "NZ",
};

function mockSuccessfulSave() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ id: member.id }),
  });
}

async function submitProfileForm() {
  fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
}

describe("ProfileForm return flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("navigates to a safe return path after a successful save", async () => {
    mockSuccessfulSave();

    render(
      <ProfileForm
        member={member}
        returnTo="/book?step=guests#review"
      />,
    );

    await submitProfileForm();

    expect(replaceMock).toHaveBeenCalledWith("/book?step=guests#review");
  });

  it("stays on the profile page when returnTo is missing", async () => {
    const onSaved = vi.fn();
    mockSuccessfulSave();

    render(<ProfileForm member={member} onSaved={onSaved} />);

    await submitProfileForm();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("does not navigate when returnTo is unsafe", async () => {
    const onSaved = vi.fn();
    mockSuccessfulSave();

    render(
      <ProfileForm
        member={member}
        onSaved={onSaved}
        returnTo="javascript:alert(1)"
      />,
    );

    await submitProfileForm();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("can render the profile form as a read-only view", () => {
    render(
      <ProfileForm
        editable={false}
        member={member}
        showSubmitButton={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
    expect((screen.getByLabelText("First Name") as HTMLInputElement).readOnly).toBe(true);
  });

  it("uses one top button to switch the profile details card from edit to save", () => {
    render(<ProfileDetailsCard member={member} />);

    expect((screen.getByLabelText("First Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("link", { name: /Back to Dashboard/ }).getAttribute("href")).toBe("/dashboard");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect((screen.getByLabelText("First Name") as HTMLInputElement).readOnly).toBe(false);
  });
});
