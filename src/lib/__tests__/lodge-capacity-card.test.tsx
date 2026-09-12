// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lodgeOptions = {
  lodges: [
    { id: "lodge-a", name: "Lodge A" },
    { id: "lodge-b", name: "Lodge B" },
  ],
  loading: false,
  failed: false,
  forbidden: false,
  reload: vi.fn(),
};

vi.mock("@/components/lodge-select", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/components/lodge-select");
  const React = await import("react");
  return {
    ...actual,
    useLodgeOptions: () => lodgeOptions,
    LodgeSelect: ({ lodges, value, onChange }: {
      lodges: Array<{ id: string; name: string }>;
      value: string | null;
      onChange: (value: string | null) => void;
    }) => {
      React.useEffect(() => {
        if (!value && lodges[0]) onChange(lodges[0].id);
      }, [lodges, onChange, value]);
      return (
        <div>
          {lodges.map((lodge) => (
            <button key={lodge.id} onClick={() => onChange(lodge.id)}>
              Choose {lodge.name}
            </button>
          ))}
        </div>
      );
    },
  };
});

// #1940: the card reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the pre-existing cases keep working.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));
vi.mock("@/hooks/use-scroll-to-feedback", () => ({
  useScrollToFeedback: () => ({
    scrollToError: vi.fn(),
    scrollToTop: vi.fn(),
  }),
}));

import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";

function settings(capacity: number) {
  return {
    capacity,
    hutLeaderLookaheadDays: 14,
    schoolGroupSoftCap: 12,
    clubConfigCapacity: 30,
  };
}

function response(status: number, body: Record<string, unknown>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function stubFetch(status: number, body: Record<string, unknown> = {}) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  lodgeOptions.lodges = [
    { id: "lodge-a", name: "Lodge A" },
    { id: "lodge-b", name: "Lodge B" },
  ];
  lodgeOptions.loading = false;
  lodgeOptions.failed = false;
  lodgeOptions.forbidden = false;
});

describe("LodgeCapacityCard — graceful cross-area 403 (#1548)", () => {
  it("renders nothing on a 403 and shows no error box", async () => {
    stubFetch(403, { error: "Forbidden" });
    render(<LodgeCapacityCard />);

    // The card is briefly visible while loading, then unmounts to null once the
    // forbidden status resolves — never the red error box.
    await waitFor(() => {
      expect(screen.queryByText("Lodge settings")).toBeNull();
    });
    expect(screen.queryByText("Failed to load lodge settings")).toBeNull();
  });

  it("keeps the error box on a genuine 500 failure", async () => {
    stubFetch(500, {});
    render(<LodgeCapacityCard />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load lodge settings")).toBeTruthy();
    });
  });
});

describe("LodgeCapacityCard lodge-switch response ownership (#2701)", () => {
  it("keeps a slow Lodge A GET from replacing the newer Lodge B values", async () => {
    const lodgeA = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("lodgeId=lodge-a")) return lodgeA.promise;
      if (url.includes("lodgeId=lodge-b")) {
        return Promise.resolve(response(200, settings(22)));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LodgeCapacityCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("lodgeId=lodge-a"),
      expect.anything(),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }));
    await waitFor(() => expect(screen.getByLabelText("Capacity (beds/guests)")).toHaveValue(22));

    await act(async () => {
      lodgeA.resolve(response(200, settings(11)));
      await lodgeA.promise;
    });
    expect(screen.getByLabelText("Capacity (beds/guests)")).toHaveValue(22);
  });

  it("does not let a Lodge A save response overwrite Lodge B or claim it was saved", async () => {
    const lodgeASave = deferred<Response>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") return lodgeASave.promise;
      if (url.includes("lodgeId=lodge-a")) {
        return Promise.resolve(response(200, settings(11)));
      }
      if (url.includes("lodgeId=lodge-b")) {
        return Promise.resolve(response(200, settings(22)));
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LodgeCapacityCard />);
    await waitFor(() => expect(screen.getByLabelText("Capacity (beds/guests)")).toHaveValue(11));
    fireEvent.change(screen.getByLabelText("Capacity (beds/guests)"), {
      target: { value: "15" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/lodge-settings",
      expect.objectContaining({ method: "PUT" }),
    ));

    fireEvent.click(screen.getByRole("button", { name: "Choose Lodge B" }));
    await waitFor(() => expect(screen.getByLabelText("Capacity (beds/guests)")).toHaveValue(22));

    await act(async () => {
      lodgeASave.resolve(response(200, settings(99)));
      await lodgeASave.promise;
    });
    expect(screen.getByLabelText("Capacity (beds/guests)")).toHaveValue(22);
    expect(screen.queryByText("Lodge settings saved.")).not.toBeInTheDocument();
  });
});
