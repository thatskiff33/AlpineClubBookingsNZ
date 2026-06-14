// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberImportDialog } from "@/app/(admin)/admin/members/_components/member-import-dialog";
import type { ImportResult } from "@/app/(admin)/admin/members/_types";

const fetchMock = vi.fn();

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: Omit<ComponentProps<"input">, "onChange"> & {
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={Boolean(checked)}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));

vi.mock("@/components/ui/label", () => ({
  Label: (props: ComponentProps<"label">) => <label {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

vi.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
}));

function jsonResponse(body: ImportResult) {
  return {
    ok: true,
    json: async () => body,
  };
}

function renderImportDialog() {
  const onImported = vi.fn();
  const onError = vi.fn();
  render(
    <MemberImportDialog
      open
      onOpenChange={vi.fn()}
      onImported={onImported}
      onError={onError}
    />,
  );
  return { onImported, onError };
}

async function uploadValidCsv() {
  const file = new File(
    [
      [
        "First Name,Last Name,Email",
        "Existing,User,existing@test.com",
        "New,User,new@test.com",
      ].join("\n"),
    ],
    "members.csv",
    { type: "text/csv" },
  );

  fireEvent.change(screen.getByLabelText("CSV File"), {
    target: { files: [file] },
  });

  await screen.findByText("members.csv");
  fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  fireEvent.click(screen.getByRole("button", { name: /Validate/ }));
  await screen.findByText("Rows Ready");
}

describe("MemberImportDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("treats zero-created imports as no-ops and keeps skipped details visible", async () => {
    const result: ImportResult = {
      created: 0,
      skipped: 2,
      skippedRows: [
        { row: 2, email: "existing@test.com", reason: "Login email already exists" },
        { row: 3, email: "new@test.com", reason: "Login email already exists" },
      ],
      errors: [],
      total: 2,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(result));
    const { onImported, onError } = renderImportDialog();

    await uploadValidCsv();
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Members/ }));

    expect(await screen.findByText("No members were imported. Review the skipped rows below."))
      .toBeTruthy();
    expect(screen.getByText(/Row 2: Login email already exists \(existing@test.com\)/))
      .toBeTruthy();
    expect(screen.getByText(/Row 3: Login email already exists \(new@test.com\)/))
      .toBeTruthy();
    expect(onImported).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports created and skipped counts and passes successful results to the parent", async () => {
    const result: ImportResult = {
      created: 2,
      skipped: 1,
      skippedRows: [
        { row: 4, email: "skipped@test.com", reason: "Login email already exists" },
      ],
      errors: [],
      total: 3,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(result));
    const { onImported } = renderImportDialog();

    await uploadValidCsv();
    fireEvent.click(screen.getByRole("button", { name: /Import 2 Members/ }));

    expect(await screen.findByText("Imported 2 member(s), skipped 1.")).toBeTruthy();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(result));
  });
});
