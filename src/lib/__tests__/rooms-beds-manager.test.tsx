// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: mockConfirm, confirmDialog: null }),
}));
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [{ id: "lodge-1", name: "Lodge One" }],
    loading: false,
    failed: false,
    forbidden: false,
    reload: vi.fn(),
  }),
  LodgeSelect: () => null,
  initialLodgeIdFromLocation: () => "lodge-1",
}));

/*
  #2937: the allocation-preferences card now sits at the bottom of this page. It
  has its own two suites, and left real it would add a second endpoint to fake
  here and a second permanently-mounted `role="alert"` region to every query in
  this file. The seam records what the manager HANDS it, which is the only part
  of it that is this file's business.
*/
vi.mock("@/components/admin/allocation-preferences-section", () => ({
  AllocationPreferencesPanel: ({
    scope,
    canEdit,
  }: {
    scope: { kind: string; lodgeId?: string };
    canEdit: boolean | undefined;
  }) => (
    <div
      data-testid="allocation-preferences-panel"
      data-scope={scope.kind}
      data-lodge={scope.lodgeId ?? ""}
      data-can-edit={String(canEdit)}
    />
  ),
}));

import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";

const ROOMS_PAYLOAD = {
  rooms: [],
  capacity: {
    capacity: 0,
    source: "unconfigured_lodge" as const,
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 0,
  },
  canImportFromConfig: false,
  configBeds: [],
};

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function stubFetch(status = 200, body: unknown = ROOMS_PAYLOAD) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoomsBedsManager — permission-aware bookings-area gating (#1598)", () => {
  it("renders the manager when the viewer has bookings access", async () => {
    stubFetch();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Rooms & Beds")).toBeTruthy();
    });
  });

  it("renders nothing (no fetch) for a lodge viewer without bookings access", async () => {
    const { calls } = stubFetch();
    const { container } = render(
      <RoomsBedsManager permissionMatrix={matrix({ lodge: "edit" })} />,
    );

    // No async load to await; the gate short-circuits synchronously.
    await waitFor(() => {
      expect(calls).toHaveLength(0);
    });
    expect(screen.queryByText("Rooms & Beds")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing quietly on a 403 from the bed-allocation load (no toast)", async () => {
    const sonner = await import("sonner");
    stubFetch(403, { error: "Forbidden" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Rooms & Beds")).toBeNull();
    });
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("does NOT quiet-hide on a genuine 500 — keeps the shell and toasts the failure", async () => {
    const sonner = await import("sonner");
    stubFetch(500, { error: "Boom" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    // A 5xx is a real failure, not a permission denial: the manager stays
    // mounted (heading visible) and surfaces the error via toast.
    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    expect(screen.getByText("Rooms & Beds")).toBeTruthy();
  });
});

interface SeedBed {
  id: string;
  roomId: string;
  name: string;
  sortOrder: number;
  active: boolean;
  bedType: "SINGLE" | "BUNK_TOP" | "BUNK_BOTTOM" | "DOUBLE";
  bunkGroup: string | null;
}

interface SeedRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  notes: string | null;
  beds: SeedBed[];
}

// A method/URL-aware, stateful fetch stub. PATCH/DELETE mutate an in-memory
// store; the follow-up GET reflects those writes, so a saved row re-syncs to
// server state while every other row's server value is unchanged — exactly the
// shape needed to observe that a sibling's unsaved draft survived a save.
function stubStatefulFetch(
  seed: SeedRoom[],
  options: {
    roomDeleteFailure?: { status: number; error: string };
    bedCreateFailure?: { status: number; error: string };
  } = {},
) {
  let rooms: SeedRoom[] = seed.map((room) => ({
    ...room,
    beds: room.beds.map((bed) => ({ ...bed })),
  }));
  const calls: Array<{ url: string; method: string }> = [];
  // One-shot gate: when set, the next list GET (a post-save refetch) blocks on
  // this promise, letting a test hold the refetch "in flight" while it types.
  let refetchGate: Promise<void> | null = null;

  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  // Mirror the real PATCH handlers, which `.trim()` the name server-side. This
  // is what makes the re-sync path load-bearing: a draft with surrounding
  // whitespace differs from the saved value until the saved row re-syncs.
  const normalize = <T extends { name?: string }>(patch: T): T =>
    typeof patch.name === "string" ? { ...patch, name: patch.name.trim() } : patch;

  const fetchMock = vi.fn(
    async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });

      const bedMatch = url.match(/\/bed-allocation\/beds\/([^/?]+)$/);
      if (bedMatch) {
        const id = bedMatch[1];
        if (method === "PATCH") {
          const patch = normalize(JSON.parse(init?.body ?? "{}") as Partial<SeedBed>);
          rooms = rooms.map((room) => ({
            ...room,
            beds: room.beds.map((bed) =>
              bed.id === id ? { ...bed, ...patch } : bed,
            ),
          }));
          const bed = rooms.flatMap((room) => room.beds).find((b) => b.id === id);
          return respond(200, { bed });
        }
        if (method === "DELETE") {
          const bed = rooms.flatMap((room) => room.beds).find((b) => b.id === id);
          rooms = rooms.map((room) => ({
            ...room,
            beds: room.beds.filter((b) => b.id !== id),
          }));
          return respond(200, { bed });
        }
      }

      if (url.endsWith("/bed-allocation/beds") && method === "POST") {
        if (options.bedCreateFailure) {
          return respond(options.bedCreateFailure.status, {
            error: options.bedCreateFailure.error,
          });
        }
        // Otherwise fall through to the unhandled 404 (the create-fails path
        // some tests rely on).
      }

      const roomMatch = url.match(/\/bed-allocation\/rooms\/([^/?]+)$/);
      if (roomMatch && method === "PATCH") {
        const id = roomMatch[1];
        const patch = normalize(JSON.parse(init?.body ?? "{}") as Partial<SeedRoom>);
        rooms = rooms.map((room) =>
          room.id === id ? { ...room, ...patch } : room,
        );
        const room = rooms.find((r) => r.id === id);
        return respond(200, { room });
      }
      if (roomMatch && method === "DELETE") {
        if (options.roomDeleteFailure) {
          return respond(options.roomDeleteFailure.status, {
            error: options.roomDeleteFailure.error,
          });
        }
        const id = roomMatch[1];
        const room = rooms.find((r) => r.id === id);
        // The room and its beds go together, mirroring the server transaction.
        rooms = rooms.filter((r) => r.id !== id);
        return respond(200, { room });
      }

      if (url.includes("/bed-allocation/rooms")) {
        if (refetchGate) {
          const gate = refetchGate;
          refetchGate = null; // one-shot
          await gate;
        }
        return respond(200, {
          rooms,
          capacity: {
            capacity: 0,
            source: "unconfigured_lodge" as const,
            bedAllocationEnabled: false,
            activeBedCount: 0,
            fallbackCapacity: 0,
          },
          canImportFromConfig: false,
          configBeds: [],
        });
      }

      return respond(404, { error: "unhandled" });
    },
  ) as unknown as typeof fetch;

  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    // Simulate a concurrent server-side deletion (a row that vanishes on the
    // next GET without going through this client's Delete button).
    deleteBedServerSide(id: string) {
      rooms = rooms.map((room) => ({
        ...room,
        beds: room.beds.filter((bed) => bed.id !== id),
      }));
    },
    // Hold the next post-save refetch open; returns a release() that lets it
    // complete. Used to drive a mid-flight edit against the in-flight save.
    gateNextRefetch() {
      let release!: () => void;
      refetchGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function seedRoom(overrides: Partial<SeedRoom> & { id: string }): SeedRoom {
  return {
    name: overrides.id,
    sortOrder: 0,
    active: true,
    notes: null,
    beds: [],
    ...overrides,
  };
}

function seedBed(overrides: Partial<SeedBed> & { id: string; roomId: string }): SeedBed {
  return {
    name: overrides.id,
    sortOrder: 0,
    active: true,
    bedType: "SINGLE",
    bunkGroup: null,
    ...overrides,
  };
}

const editorMatrix = () => matrix({ lodge: "edit", bookings: "edit" });

function rowOf(displayValue: string): HTMLElement {
  const input = screen.getByDisplayValue(displayValue);
  const row = input.closest("tr");
  if (!row) throw new Error(`No table row for input "${displayValue}"`);
  return row as HTMLElement;
}

describe("RoomsBedsManager — a save preserves other unsaved drafts (#1673)", () => {
  it("saving bed A keeps bed B's unsaved draft and re-syncs bed A", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" }),
          seedBed({ id: "bed-b", roomId: "room-1", name: "Bed B" }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed B"), {
      target: { value: "Bed B edited" },
    });

    // Both rows are now dirty.
    expect(screen.getAllByText("Unsaved")).toHaveLength(2);

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    // After the save + refetch: bed B's draft is untouched, bed A reflects the
    // saved value, and only bed B still reads as unsaved.
    await waitFor(() => {
      expect(screen.getAllByText("Unsaved")).toHaveLength(1);
    });
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    expect(screen.getByDisplayValue("Bed B edited")).toBeTruthy();
    // The surviving "Unsaved" badge belongs to bed B.
    expect(within(rowOf("Bed B edited")).getByText("Unsaved")).toBeTruthy();
    expect(within(rowOf("Bed A edited")).queryByText("Unsaved")).toBeNull();
  });

  it("saving a bed in one room keeps an unsaved room-name draft in another room", async () => {
    stubStatefulFetch([
      seedRoom({ id: "room-1", name: "Room 1" }),
      seedRoom({
        id: "room-2",
        name: "Room 2",
        beds: [seedBed({ id: "bed-x", roomId: "room-2", name: "Bed X" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed X");

    fireEvent.change(screen.getByDisplayValue("Room 1"), {
      target: { value: "Room 1 edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed X"), {
      target: { value: "Bed X edited" },
    });

    fireEvent.click(within(rowOf("Bed X edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed X edited")).toBeTruthy();
    });
    // The room-name draft in the untouched room survived the sibling save.
    expect(screen.getByDisplayValue("Room 1 edited")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("shows the Unsaved badge on edit and clears it after a successful save", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");
    expect(screen.queryByText("Unsaved")).toBeNull();

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
  });

  it("drops a stale draft for a bed deleted server-side, keeping a sibling's draft", async () => {
    const server = stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" }),
          seedBed({ id: "bed-b", roomId: "room-1", name: "Bed B" }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed B"), {
      target: { value: "Bed B edited" },
    });

    // Bed B disappears server-side, then a plain refresh re-fetches.
    server.deleteBedServerSide("bed-b");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Bed B edited")).toBeNull();
    });
    // Bed A's unsaved draft survives the refresh; only its badge remains.
    expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    expect(screen.getAllByText("Unsaved")).toHaveLength(1);
  });

  it("re-syncs the just-saved row to the normalized server value, clearing its badge", async () => {
    // Discriminates the re-sync path: the draft ("Bed A " with a trailing
    // space) differs from the trimmed server value, so without re-syncing the
    // saved row its "Unsaved" badge would never clear.
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A " },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    // getByDisplayValue trims for matching, so "Bed A" still locates the row.
    const row = rowOf("Bed A");
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    // The saved row now holds the trimmed value, not the raw draft.
    const nameInput = within(rowOf("Bed A")).getByRole(
      "textbox",
    ) as HTMLInputElement;
    expect(nameInput.value).toBe("Bed A");
  });

  it("re-syncs a just-saved room to the normalized server value, clearing its badge", async () => {
    // Mirror of the bed re-sync test, but through saveRoom -> mergeRoomEdits.
    // Seed a bedless room so the only "Save" button is the room's.
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.change(screen.getByDisplayValue("Room 1"), {
      target: { value: "Room 1 " },
    });
    expect(screen.getByText("Unsaved")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.queryByText("Unsaved")).toBeNull();
    });
    // getByDisplayValue trims for matching; assert the raw value is trimmed.
    const nameInput = screen.getByDisplayValue("Room 1") as HTMLInputElement;
    expect(nameInput.value).toBe("Room 1");
  });

  it("keeps a mid-flight edit to the just-saved row instead of clobbering it", async () => {
    const server = stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A v1" },
    });

    // Save "v1", but hold the refetch open so the row is still "in flight".
    const saveButton = within(rowOf("Bed A v1")).getByRole("button", {
      name: "Save",
    });
    const releaseRefetch = server.gateNextRefetch();
    fireEvent.click(saveButton);

    // The input stays editable during the save: the admin types "v2".
    fireEvent.change(screen.getByDisplayValue("Bed A v1"), {
      target: { value: "Bed A v2" },
    });

    // Let the (stale-for-v2) refetch land; the newer draft must NOT be clobbered.
    await act(async () => {
      releaseRefetch();
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed A v2")).toBeTruthy();
    });
    // The mid-flight edit is newer than what was saved, so it stays unsaved.
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("keeps the room/bed add-form drafts across a sibling save", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    fireEvent.change(screen.getByPlaceholderText("Room name"), {
      target: { value: "New room draft" },
    });
    fireEvent.change(screen.getByPlaceholderText("Bed name"), {
      target: { value: "New bed draft" },
    });
    fireEvent.change(screen.getByDisplayValue("Bed A"), {
      target: { value: "Bed A edited" },
    });

    fireEvent.click(within(rowOf("Bed A edited")).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed A edited")).toBeTruthy();
    });
    // The add-forms are independent of the refetch and keep their text.
    expect(screen.getByDisplayValue("New room draft")).toBeTruthy();
    expect(screen.getByDisplayValue("New bed draft")).toBeTruthy();
  });

  it("keeps the Add Bed draft when the create request fails", async () => {
    const sonner = await import("sonner");
    // The stub returns 404 for POST /beds (no matching handler), so the create
    // fails and the draft must survive rather than being wiped.
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.change(screen.getByPlaceholderText("Bed name"), {
      target: { value: "Draft bed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Bed" }));

    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    // Failed create leaves the typed value in place.
    expect(screen.getByDisplayValue("Draft bed")).toBeTruthy();
  });
});

describe("RoomsBedsManager — room delete (#1674)", () => {
  afterEach(() => {
    mockConfirm.mockReset();
  });

  it("confirms (warning about beds), deletes the room, and refreshes the list", async () => {
    mockConfirm.mockResolvedValue(true);
    const sonner = await import("sonner");
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" })],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));

    // The confirm dialog spells out that the beds are deleted too.
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("beds"),
        destructive: true,
      }),
    );

    // After the delete + refetch the room (and its bed) are gone.
    await waitFor(() => {
      expect(screen.queryByDisplayValue("Room 1")).toBeNull();
    });
    expect(screen.queryByDisplayValue("Bed A")).toBeNull();
    expect(sonner.toast.success).toHaveBeenCalledWith("Room deleted");
  });

  it("does nothing when the delete is not confirmed", async () => {
    mockConfirm.mockResolvedValue(false);
    const { calls } = stubStatefulFetch([
      seedRoom({ id: "room-1", name: "Room 1" }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    // No DELETE was issued and the room stays.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(screen.getByDisplayValue("Room 1")).toBeTruthy();
  });

  it("surfaces the guard-failure steering message inline (not as a toast)", async () => {
    mockConfirm.mockResolvedValue(true);
    const sonner = await import("sonner");
    const message =
      "This room has allocation history and cannot be deleted. Deactivate it instead.";
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })], {
      roomDeleteFailure: { status: 409, error: message },
    });
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    // Isolate from any toast.error calls made by earlier tests in this file
    // (the module-level sonner mock's call history is not reset between them).
    vi.mocked(sonner.toast.error).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Delete room" }));

    await waitFor(() => {
      expect(screen.getByText(message)).toBeTruthy();
    });
    // The inline message is rendered as an alert next to the room controls.
    expect(screen.getByRole("alert").textContent).toBe(message);
    // The room stays (deactivate remains the alternative) and the message is
    // inline, not a transient toast.
    expect(screen.getByDisplayValue("Room 1")).toBeTruthy();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });
});

describe("RoomsBedsManager — bed types & bunk pairing (#1675)", () => {
  it("reveals the bunk-group input and a soft unpaired warning for a bunk type", async () => {
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");

    // The add-bed form exposes a Bed type select; a single bed shows no group.
    const bedType = screen.getByLabelText("Bed type");
    expect(screen.queryByLabelText("Bunk group")).toBeNull();

    fireEvent.change(bedType, { target: { value: "BUNK_TOP" } });

    // A bunk type reveals the group input plus a non-blocking unpaired hint.
    expect(screen.getByLabelText("Bunk group")).toBeTruthy();
    expect(screen.getByText(/Unpaired bunk/)).toBeTruthy();

    // Naming the group clears the warning and shows the pairing label.
    fireEvent.change(screen.getByLabelText("Bunk group"), {
      target: { value: "Bunk A" },
    });
    expect(screen.queryByText(/Unpaired bunk/)).toBeNull();
    expect(screen.getByText("Bunk A · top")).toBeTruthy();
  });

  it("renders the pairing labels for a fully paired bunk (both beds present)", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({
            id: "bed-top",
            roomId: "room-1",
            name: "Upper",
            bedType: "BUNK_TOP",
            bunkGroup: "Bunk A",
          }),
          seedBed({
            id: "bed-bottom",
            roomId: "room-1",
            name: "Lower",
            bedType: "BUNK_BOTTOM",
            bunkGroup: "Bunk A",
          }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Upper");
    // A complete pair reads with its pairing labels and raises no unpaired hint.
    expect(screen.getByText("Bunk A · top")).toBeTruthy();
    expect(screen.getByText("Bunk A · bottom")).toBeTruthy();
    expect(screen.queryByText(/Unpaired bunk/)).toBeNull();
  });

  it("shows the unpaired hint (not a pairing label) for a half-pair whose partner is gone", async () => {
    // A lone bunk-top in "Bunk A" (no bottom persisted) must not imply a partner
    // via "Bunk A · top"; it shows the plain type label and the soft hint.
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({
            id: "bed-top",
            roomId: "room-1",
            name: "Upper",
            bedType: "BUNK_TOP",
            bunkGroup: "Bunk A",
          }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Upper");
    const row = rowOf("Upper");
    // No pairing label (that would imply a partner); the soft hint shows instead.
    // ("Bunk (top)" is not asserted here because the row's type <select> also
    // carries a "Bunk (top)" <option> with the same text.)
    expect(within(row).queryByText("Bunk A · top")).toBeNull();
    expect(within(row).getByText(/Unpaired bunk/)).toBeTruthy();
  });

  it("marks a row Unsaved when only the bed type changes and keeps that draft across a sibling save", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({ id: "bed-a", roomId: "room-1", name: "Bed A" }),
          seedBed({ id: "bed-b", roomId: "room-1", name: "Bed B" }),
        ],
      }),
    ]);
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Bed A");

    // Change ONLY bed A's type (a non-bunk type, so no group input appears).
    fireEvent.change(within(rowOf("Bed A")).getByLabelText("Bed type"), {
      target: { value: "DOUBLE" },
    });
    expect(within(rowOf("Bed A")).getByText("Unsaved")).toBeTruthy();

    // Save sibling bed B; bed A's type draft must survive the refetch.
    fireEvent.change(screen.getByDisplayValue("Bed B"), {
      target: { value: "Bed B edited" },
    });
    fireEvent.click(
      within(rowOf("Bed B edited")).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => {
      expect(screen.getByDisplayValue("Bed B edited")).toBeTruthy();
    });
    const selectA = within(rowOf("Bed A")).getByLabelText(
      "Bed type",
    ) as HTMLSelectElement;
    expect(selectA.value).toBe("DOUBLE");
    expect(within(rowOf("Bed A")).getByText("Unsaved")).toBeTruthy();
  });

  it("surfaces a server bunk-pairing rejection inline on the add-bed form", async () => {
    const sonner = await import("sonner");
    const message =
      'Bunk group "Bunk A" already has two beds. A bunk pairs one top and one bottom.';
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })], {
      bedCreateFailure: { status: 409, error: message },
    });
    render(<RoomsBedsManager permissionMatrix={editorMatrix()} />);

    await screen.findByDisplayValue("Room 1");
    vi.mocked(sonner.toast.error).mockClear();

    fireEvent.change(screen.getByPlaceholderText("Bed name"), {
      target: { value: "Third bunk" },
    });
    fireEvent.change(screen.getByLabelText("Bed type"), {
      target: { value: "BUNK_TOP" },
    });
    fireEvent.change(screen.getByLabelText("Bunk group"), {
      target: { value: "Bunk A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add Bed" }));

    // The rejection surfaces inline as an alert AND toasts.
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(message);
    });
    expect(sonner.toast.error).toHaveBeenCalled();
    // The typed draft survives the failed create.
    expect(screen.getByDisplayValue("Third bunk")).toBeTruthy();
    expect(screen.getByDisplayValue("Bunk A")).toBeTruthy();
  });
});

describe("RoomsBedsManager — bunk-group suggestions (#1702)", () => {
  it("suggests the room's existing bunk groups via a per-room datalist, locale-sorted", async () => {
    // Mixed casing discriminates the sort: a plain code-unit `.sort()` would put
    // "Bunk B" before "bunk a" (uppercase B < lowercase b); localeCompare keeps
    // them in reading order.
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({
            id: "bed-a",
            roomId: "room-1",
            name: "Upper",
            bedType: "BUNK_TOP",
            bunkGroup: "Bunk B",
          }),
          seedBed({
            id: "bed-b",
            roomId: "room-1",
            name: "Solo",
            bedType: "BUNK_TOP",
            bunkGroup: "bunk a",
          }),
        ],
      }),
    ]);
    const { container } = render(
      <RoomsBedsManager permissionMatrix={editorMatrix()} />,
    );

    await screen.findByDisplayValue("Upper");

    // One datalist per room holding its distinct group names, locale-sorted.
    const datalist = container.querySelector("#bunk-groups-room-1");
    expect(datalist).not.toBeNull();
    const suggestions = Array.from(datalist!.querySelectorAll("option")).map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(suggestions).toEqual(["bunk a", "Bunk B"]);

    // The edit-row bunk-group input is wired to the room's datalist.
    const editInput = within(rowOf("Upper")).getByLabelText("Bunk group");
    expect(editInput.getAttribute("list")).toBe("bunk-groups-room-1");
  });

  it("de-duplicates a paired group to a single datalist option", async () => {
    // Both beds of a real top+bottom pair share one group; the suggestion list
    // must show that group once, not once per bed.
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({
            id: "top",
            roomId: "room-1",
            name: "Upper",
            bedType: "BUNK_TOP",
            bunkGroup: "Bunk A",
          }),
          seedBed({
            id: "bottom",
            roomId: "room-1",
            name: "Lower",
            bedType: "BUNK_BOTTOM",
            bunkGroup: "Bunk A",
          }),
        ],
      }),
    ]);
    const { container } = render(
      <RoomsBedsManager permissionMatrix={editorMatrix()} />,
    );

    await screen.findByDisplayValue("Upper");

    const options = Array.from(
      container.querySelector("#bunk-groups-room-1")!.querySelectorAll("option"),
    ).map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(["Bunk A"]);
  });

  it("wires the add-bed bunk-group input to the room's datalist", async () => {
    // A bedless room keeps the query unambiguous: switching the add form to a
    // bunk type reveals exactly one bunk-group input, wired to the (empty)
    // datalist so free text still creates new groups.
    stubStatefulFetch([seedRoom({ id: "room-1", name: "Room 1" })]);
    const { container } = render(
      <RoomsBedsManager permissionMatrix={editorMatrix()} />,
    );

    await screen.findByDisplayValue("Room 1");

    // The datalist renders even with no groups yet, so the reference resolves.
    expect(container.querySelector("#bunk-groups-room-1")).not.toBeNull();

    fireEvent.change(screen.getByLabelText("Bed type"), {
      target: { value: "BUNK_TOP" },
    });
    expect(
      screen.getByLabelText("Bunk group").getAttribute("list"),
    ).toBe("bunk-groups-room-1");
  });

  it("scopes bunk-group suggestions to each room", async () => {
    stubStatefulFetch([
      seedRoom({
        id: "room-1",
        name: "Room 1",
        beds: [
          seedBed({
            id: "bed-a",
            roomId: "room-1",
            name: "Alpha bed",
            bedType: "BUNK_TOP",
            bunkGroup: "Alpha",
          }),
        ],
      }),
      seedRoom({
        id: "room-2",
        name: "Room 2",
        beds: [
          seedBed({
            id: "bed-b",
            roomId: "room-2",
            name: "Beta bed",
            bedType: "BUNK_TOP",
            bunkGroup: "Beta",
          }),
        ],
      }),
    ]);
    const { container } = render(
      <RoomsBedsManager permissionMatrix={editorMatrix()} />,
    );

    await screen.findByDisplayValue("Alpha bed");

    const optionsOf = (selector: string) =>
      Array.from(
        container.querySelector(selector)!.querySelectorAll("option"),
      ).map((option) => (option as HTMLOptionElement).value);

    // A room's datalist holds only its own groups — never a sibling room's.
    expect(optionsOf("#bunk-groups-room-1")).toEqual(["Alpha"]);
    expect(optionsOf("#bunk-groups-room-2")).toEqual(["Beta"]);

    // Each edit-row input points at its own room's datalist.
    expect(
      within(rowOf("Alpha bed"))
        .getByLabelText("Bunk group")
        .getAttribute("list"),
    ).toBe("bunk-groups-room-1");
    expect(
      within(rowOf("Beta bed"))
        .getByLabelText("Bunk group")
        .getAttribute("list"),
    ).toBe("bunk-groups-room-2");
  });
});

describe("RoomsBedsManager — allocation preferences live here (#2937)", () => {
  it("hands the panel this page's own settled lodge scope and bookings edit access", async () => {
    stubFetch();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "edit" })}
      />,
    );

    const panel = await screen.findByTestId("allocation-preferences-panel");
    // One lodge selector on the page, one derivation of the scope, and the
    // preferences card reads the SAME one the rooms inventory does — which is
    // the whole reason this is the editor's home rather than a second page with
    // a second selector.
    expect(panel.getAttribute("data-scope")).toBe("lodge");
    expect(panel.getAttribute("data-lodge")).toBe("lodge-1");
    expect(panel.getAttribute("data-can-edit")).toBe("true");
  });

  it("offers no edit path to a view-only bookings role", async () => {
    stubFetch();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    const panel = await screen.findByTestId("allocation-preferences-panel");
    expect(panel.getAttribute("data-can-edit")).toBe("false");
  });
});
