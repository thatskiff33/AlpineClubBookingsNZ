import { type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  overrideSingleLodgeAutoAllocation,
  setBedAllocationSettings,
  type BedAllocationSettingsSnapshot,
  resolveSingleActiveLodgeId,
} from "./helpers/bed-allocation-settings";
import { completeMemberDetailsGateIfShown } from "./helpers/booking";
import {
  DEMO_BOOKING_WINDOWS,
  E2E_ADMIN,
  shiftDateOnly,
} from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Approve a review-flagged booking,
// then allocate its guests to specific beds." The seeded AWAITING_REVIEW booking
// bReview (owner Ken King, adminReviewStatus PENDING, on a RELATIVE future
// window — DEMO_BOOKING_WINDOWS.kenReview, prisma/demo-seed.ts, issue #2117) is
// approved through the admin approvals panel, then Ken's
// guest is placed on a specific bed via the manual Select + Allocate path (NOT
// drag-and-drop) on the bed-allocation board, and the manual draft placement is
// approved.
//
// Auto-allocation is turned OFF for this run: the E2E stack seeds no
// BedAllocationSettings row, so it defaults ON, and approval's
// reconcileBedAllocationsForBooking would otherwise auto-place Ken (removing him
// from the "awaiting allocation" bucket the manual path drives). The setting is
// restored afterwards. No other spec touches bed allocation.
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;
let bedAllocationSettingsBefore: BedAllocationSettingsSnapshot | undefined;

test.beforeAll(async ({ browser }) => {
  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Disable auto-allocation so approval parks Ken in the manual bucket.
  bedAllocationSettingsBefore = await overrideSingleLodgeAutoAllocation(
    adminContext.request,
    false,
  );
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      if (bedAllocationSettingsBefore) {
        await setBedAllocationSettings(
          adminContext.request,
          {
            ...bedAllocationSettingsBefore,
            // The demo seed has no settings row, so its authoritative default
            // is enabled. A killed prior worker may have left our false
            // override persisted; always restore the seed behaviour, not that
            // dirty retry snapshot.
            autoAllocationEnabled: true,
          },
        );
      }
    }
  } finally {
    await adminContext?.close();
  }
});

test("an admin approves a review-flagged booking then allocates a bed to its guest", async ({}, testInfo) => {
  const page = await adminContext.newPage();

  // ── Approve Ken King's review-flagged booking ──
  // /admin/booking-approvals redirects to /admin/booking-requests?tab=approvals;
  // the approvals panel defaults to the PENDING filter, where Ken's card sits.
  await page.goto("/admin/booking-approvals");
  await expect(page).toHaveURL(/\/admin\/booking-requests/);
  const pendingKen = page.getByText("Ken King", { exact: true }).first();
  const needsBookingApproval = await pendingKen
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (needsBookingApproval) {
    // "Approve" (exact) so it never matches the "Approved" status-filter button.
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    // #1790: the approve action now opens a notify-choice dialog; confirm the
    // default notify path ("Approve and email member") to complete the approval.
    await page
      .getByRole("button", { name: "Approve and email member" })
      .click();
    await expect(page.getByText("Booking approved.")).toBeVisible();
  } else {
    // A serial retry re-enters here after the preceding attempt may already
    // have approved Ken. Treat that as idempotent setup, but never let a clean
    // first attempt silently skip the high-row approval proof.
    expect(
      testInfo.retry,
      "Ken may be absent from pending review only on a serial retry",
    ).toBeGreaterThan(0);
  }

  // ── Allocate Ken's guest to Bunk Room A / A1 via Select + Allocate ──
  // Board window matches Ken's RELATIVE seeded booking (issue #2117).
  const ken = DEMO_BOOKING_WINDOWS.kenReview;
  await page.goto(
    `/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  await expect(
    page.getByRole("heading", { name: "Bed Allocation" }),
  ).toBeVisible();

  const dashboardPath = `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`;
  const readKenAllocations = async () => {
    const response = await adminContext.request.get(dashboardPath);
    expect(
      response.ok(),
      `read Ken retry setup (${response.status()})`,
    ).toBeTruthy();
    const body = (await response.json()) as {
      allocations: Array<{ guestName: string; approvedAt: string | null }>;
    };
    return body.allocations.filter((allocation) =>
      allocation.guestName.includes("Ken"),
    );
  };
  let kenAllocations = await readKenAllocations();
  if (kenAllocations.length === 0) {
    // Ken's guest chip in the "awaiting allocation" bucket. Both the booking
    // card and inner guest chip carry "Ken King" + Allocate, so last() is the
    // guest chip. This also repairs a retry whose prior worker died after the
    // staged-removal apply and before its finally cleanup could run.
    const kenChip = page
      .locator("div")
      .filter({ hasText: "Ken King" })
      .filter({ has: page.getByRole("button", { name: "Allocate" }) })
      .last();
    await expect(kenChip).toBeVisible({ timeout: 30_000 });

    // Open the grouped bed Select (Radix combobox, room label + bed option) and
    // choose a free bed, then Allocate.
    await kenChip.getByRole("combobox").click();
    await page
      .getByRole("group", { name: "Bunk Room A" })
      .getByRole("option", { name: "A1", exact: true })
      .click();
    await kenChip.getByRole("button", { name: "Allocate" }).click();
    await expect(page.getByText("Allocation saved")).toBeVisible();
    kenAllocations = await readKenAllocations();
  }

  // The board now shows Ken on a bed as a MANUAL, still-Draft allocation. "Draft"
  // is asserted exact so it never matches the "N draft allocations to approve"
  // summary badge (lowercase "draft").
  await expect(page.getByText("Ken King").first()).toBeVisible();
  await expect(page.getByText("MANUAL").first()).toBeVisible();

  // ── Approve the visible draft allocations ──
  if (kenAllocations.some((allocation) => allocation.approvedAt === null)) {
    await expect(
      page.getByText("Draft", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve Visible" }).click();
    await expect(page.getByText("Allocations approved")).toBeVisible();
  }
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  await page.close();
});

test("pointer, keyboard and menu moves share reviewed scopes and preserve original dates", async ({}, testInfo) => {
  const ken = DEMO_BOOKING_WINDOWS.kenReview;
  // Include the checkout date as one extra visible column so the pointer can
  // hover horizontally over a date Ken is not allocated on. Existing-chip
  // semantics must still snap back to the persisted source nights.
  const extendedTo = shiftDateOnly(ken.checkOut, 1);
  const dashboardPath = `/api/admin/bed-allocation?from=${ken.checkIn}&to=${extendedTo}`;
  const dashboard = await adminContext.request.get(dashboardPath);
  expect(dashboard.ok(), `read the board (${dashboard.status()})`).toBeTruthy();
  const payload = (await dashboard.json()) as {
    rooms: Array<{
      name: string;
      active: boolean;
      beds: Array<{ id: string; name: string; active: boolean }>;
    }>;
    allocations: Array<{
      id: string;
      bookingId: string;
      bookingGuestId: string;
      bedId: string;
      stayDate: string;
      guestName: string;
      approvedAt: string | null;
    }>;
    custodianHolds: Array<{ bedId: string; nights: string[] }>;
  };
  const kensAllocations = payload.allocations
    .filter((allocation) => allocation.guestName.includes("Ken"))
    .sort((left, right) => left.stayDate.localeCompare(right.stayDate));
  expect(kensAllocations.length).toBeGreaterThan(0);
  const originalDates = kensAllocations.map(
    (allocation) => allocation.stayDate,
  );
  const occupiedKeys = new Set(
    payload.allocations.map(
      (allocation) => `${allocation.bedId}:${allocation.stayDate}`,
    ),
  );
  const heldKeys = new Set(
    payload.custodianHolds.flatMap((hold) =>
      hold.nights.map((night) => `${hold.bedId}:${night}`),
    ),
  );
  const destination = payload.rooms
    .filter((room) => room.active)
    .flatMap((room) =>
      room.beds.map((bed) => ({ ...bed, roomName: room.name })),
    )
    .find(
      (bed) =>
        bed.active &&
        bed.id !== kensAllocations[0].bedId &&
        originalDates.every(
          (night) =>
            !occupiedKeys.has(`${bed.id}:${night}`) &&
            !heldKeys.has(`${bed.id}:${night}`),
        ),
    );
  expect(destination, "a free destination bed exists").toBeTruthy();
  const originalBedIds = new Set(
    kensAllocations.map((allocation) => allocation.bedId),
  );
  expect(
    originalBedIds.size,
    "the seeded full-stay placement starts on one bed",
  ).toBe(1);
  const originalBedId = [...originalBedIds][0];
  if (!originalBedId) {
    throw new Error("Ken's seeded full-stay placement has no source bed");
  }
  const originalBed = payload.rooms
    .flatMap((room) =>
      room.beds.map((bed) => ({ ...bed, roomName: room.name })),
    )
    .find((bed) => bed.id === originalBedId);
  expect(originalBed, "the source bed remains in active board inventory").toBeTruthy();
  const allocationIds = kensAllocations.map((allocation) => allocation.id);
  const originalApprovedAllocationIds = kensAllocations
    .filter((allocation) => allocation.approvedAt !== null)
    .map((allocation) => allocation.id);
  expect(
    originalApprovedAllocationIds,
    "the preceding serial scenario leaves every Ken allocation approved",
  ).toEqual(allocationIds);

  const page = await adminContext.newPage();
  const moveRequests: Array<{
    anchorAllocationId: string;
    destinationBedId: string;
    scope: "ALLOCATION_NIGHT" | "BOOKING_GUEST";
    previewDigest: string;
  }> = [];
  let scenarioError: unknown;
  try {
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname ===
          "/api/admin/bed-allocation/allocations"
      ) {
        moveRequests.push(
          request.postDataJSON() as {
            anchorAllocationId: string;
            destinationBedId: string;
            scope: "ALLOCATION_NIGHT" | "BOOKING_GUEST";
            previewDigest: string;
          },
        );
      }
    });
    await page.goto(`/admin/bed-allocation?from=${ken.checkIn}&to=${extendedTo}`);

    const dragHandle = () =>
      page
      .getByRole("button", {
        name: /Drag Ken King to another bed; original lodge night .* will be kept/,
      })
      .first();
    const targetRow = () =>
      page
      .getByRole("row")
      .filter({ has: page.getByText(destination!.name, { exact: true }) });
    const targetCell = () =>
      targetRow().locator(`td[data-stay-date="${ken.checkOut}"]`);
    // The exact sentence the reviewed-move drag card renders
    // (`allocation-drag-feedback.ts`, planBedAllocationDropFeedback's "review"
    // outcome). Naming the destination bed inside the filter is what makes a
    // wrong-row collision fail loudly instead of passing on a neighbour.
    const preview = () =>
      page
        .getByTestId("bed-allocation-drag-feedback")
        .filter({
          hasText: `to ${destination!.roomName} / ${destination!.name}; choose the exact scope before confirming and keep every original lodge night`,
        });

    // The floating drag card. It is mounted ONLY while a drag is live (the
    // DragOverlay renders it from `activeDragLabel`), so "hidden" is the honest
    // signal that no drag is in flight.
    const dragCard = () => page.getByTestId("bed-allocation-drag-feedback");

    // Geometry is re-measured immediately before EVERY drag rather than cached
    // across both of them, because the board's own layout is free to change
    // between two drags in the same test (a restored placement re-renders the
    // rows). Coordinates taken before the first drag can therefore resolve a
    // DIFFERENT row on the second one, and the symptom is not shaped like a
    // geometry failure: the drag is live and the card is up, only naming the
    // wrong bed, so a hasText-filtered locator matches nothing and times out.
    //
    // The offset arithmetic below aims the dragged CHIP's centre at the target
    // cell, which is only correct because the DragOverlay's measured frame is
    // pinned to the chip's rect (see the DragOverlay comment in
    // bed-allocation/page.tsx). Do not let the floating card become the measured
    // element again: closestCenter would then follow the card's own height and
    // this drag would settle one row below the cell it was aimed at.
    const startPointerDragToTarget = async () => {
      await targetCell().scrollIntoViewIfNeeded();
      await dragHandle().scrollIntoViewIfNeeded();
      const from = await dragHandle().boundingBox();
      const to = await targetCell().boundingBox();
      const dragged = await dragHandle().locator("xpath=..").boundingBox();
      expect(from).toBeTruthy();
      expect(to).toBeTruthy();
      expect(dragged).toBeTruthy();
      const viewport = page.viewportSize();
      expect(viewport, "the pointer scenario has a fixed viewport").toBeTruthy();
      for (const [label, box] of [
        ["drag handle", from],
        ["target cell", to],
      ] as const) {
        const center = {
          x: box!.x + box!.width / 2,
          y: box!.y + box!.height / 2,
        };
        expect(
          center.x,
          `${label} centre is inside the viewport`,
        ).toBeGreaterThanOrEqual(0);
        expect(center.x, `${label} centre is inside the viewport`).toBeLessThan(
          viewport!.width,
        );
        expect(
          center.y,
          `${label} centre is inside the viewport`,
        ).toBeGreaterThanOrEqual(0);
        expect(center.y, `${label} centre is inside the viewport`).toBeLessThan(
          viewport!.height,
        );
      }
      // DndContext uses closestCenter, so preserve the handle-to-card-centre grab
      // offset and aim the dragged CARD's centre at the destination cell. If the
      // offset would put the cursor just outside that cell, clamp it one pixel
      // inside while staying as close as possible to the ideal alignment.
      const idealTargetPointer = {
        x:
          to!.x +
          to!.width / 2 +
          (from!.x + from!.width / 2 - (dragged!.x + dragged!.width / 2)),
        y:
          to!.y +
          to!.height / 2 +
          (from!.y + from!.height / 2 - (dragged!.y + dragged!.height / 2)),
      };
      const targetPointer = {
        x: Math.min(
          Math.max(idealTargetPointer.x, to!.x + 1),
          to!.x + to!.width - 1,
        ),
        y: Math.min(
          Math.max(idealTargetPointer.y, to!.y + 1),
          to!.y + to!.height - 1,
        ),
      };
      expect(
        targetPointer.x,
        "adjusted pointer x stays inside the target cell",
      ).toBeGreaterThanOrEqual(to!.x);
      expect(
        targetPointer.x,
        "adjusted pointer x stays inside the target cell",
      ).toBeLessThan(to!.x + to!.width);
      expect(
        targetPointer.y,
        "adjusted pointer y stays inside the target cell",
      ).toBeGreaterThanOrEqual(to!.y);
      expect(
        targetPointer.y,
        "adjusted pointer y stays inside the target cell",
      ).toBeLessThan(to!.y + to!.height);
      await page.mouse.move(
        from!.x + from!.width / 2,
        from!.y + from!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(targetPointer.x, targetPointer.y, {
        steps: 12,
      });
      await expect(preview()).toBeVisible();
    };

    // Pointer preview + cancel: real sensor wiring, no request.
    await startPointerDragToTarget();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    // The cancel really tore the drag down, and waiting for that here is what
    // lets the next drag measure a settled board instead of one still animating
    // the overlay home.
    await expect(dragCard()).toBeHidden();
    await expect.poll(() => moveRequests.length).toBe(0);

    // Pointer success opens the authoritative dialog and sends no write until
    // the operator widens scope, reviews the exact rows, and confirms.
    await startPointerDragToTarget();
    await page.mouse.up();
    const moveDialog = page.getByRole("dialog", {
      name: new RegExp(`Move Ken King to ${destination!.roomName} / ${destination!.name}`),
    });
    await expect(moveDialog).toBeVisible();
    await expect.poll(() => moveRequests.length).toBe(0);
    await expect(
      moveDialog.getByRole("radio", { name: /This allocation night/ }),
    ).toBeChecked();
    await moveDialog
      .getByRole("radio", { name: /This person on this booking/ })
      .check();
    await expect(
      moveDialog.getByText(
        `${allocationIds.length} changing, 0 unchanged, ${allocationIds.length} total`,
        { exact: false },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      moveDialog.getByText(/approved allocations? will become unapproved Manual drafts/),
    ).toBeVisible();
    await moveDialog.getByRole("button", { name: "Confirm move" }).click();
    await expect(moveDialog).toBeHidden({ timeout: 30_000 });
    expect(moveRequests).toHaveLength(1);
    expect(moveRequests[0]).toMatchObject({
      destinationBedId: destination!.id,
      scope: "BOOKING_GUEST",
    });
    // The headline invariant: Apply carries the scope, anchor, destination and
    // digest — NEVER a target date. `toMatchObject` above permits extra
    // properties, so this is the assertion that would fail if the hovered date
    // column ever leaked back into the payload.
    expect(moveRequests[0]).not.toHaveProperty("stayDate");
    expect(allocationIds).toContain(moveRequests[0].anchorAllocationId);
    expect(moveRequests[0].previewDigest).toMatch(/^v1:[0-9a-f]{64}$/);

    const readPersisted = async () => {
      const response = await adminContext.request.get(dashboardPath);
      expect(
        response.ok(),
        `read persisted board (${response.status()})`,
      ).toBeTruthy();
      const current = (await response.json()) as typeof payload;
      return current.allocations
        .filter((allocation) => allocation.guestName.includes("Ken"))
        .sort((left, right) => left.stayDate.localeCompare(right.stayDate));
    };
    let persisted = await readPersisted();
    expect(persisted.map((allocation) => allocation.stayDate)).toEqual(
      originalDates,
    );
    expect(
      persisted.every(
        (allocation) => allocation.bedId === destination!.id,
      ),
    ).toBe(true);

    // Restore the seeded bed through the service before exercising the keyboard
    // sensor. This keeps the fixture deterministic and prevents the successful
    // pointer proof from deciding the keyboard source/destination geometry.
    const restoreAfterPointer = await adminContext.request.patch(
      "/api/admin/bed-allocation/allocations",
      {
        data: {
          allocationIds,
          bedId: originalBedId,
        },
      },
    );
    expect(
      restoreAfterPointer.ok(),
      `restore after pointer drop (${restoreAfterPointer.status()})`,
    ).toBeTruthy();
    await page.reload();
    await expect(dragHandle()).toBeVisible();

    async function moveKeyboardFocusToDestination() {
      const sourceBox = await dragHandle().boundingBox();
      const destinationBox = await targetCell().boundingBox();
      expect(sourceBox).toBeTruthy();
      expect(destinationBox).toBeTruthy();
      const direction =
        destinationBox!.y >= sourceBox!.y ? "ArrowDown" : "ArrowUp";
      const maxSteps =
        Math.ceil(
          Math.abs(
            destinationBox!.y +
              destinationBox!.height / 2 -
              (sourceBox!.y + sourceBox!.height / 2),
          ) / 25,
        ) + 4;
      for (let step = 0; step < maxSteps; step += 1) {
        await page.keyboard.press(direction);
        // DndContext publishes the keyboard coordinate first and derives its
        // closest-center collision in the following render/effect cycle. Let
        // that collision settle before deciding whether to send another arrow;
        // an immediate getter can see A2 from the prior key while a queued key
        // is already advancing the drag to A3.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              );
            }),
        );
        if (await preview().isVisible().catch(() => false)) return;
      }
      throw new Error(
        `Keyboard sensor did not reach ${destination!.roomName} / ${destination!.name}`,
      );
    }

    // Start a keyboard drag only once the previous one has actually ended.
    //
    // `preview()` is filtered by the DESTINATION's own text, and the settle loop
    // above returns the moment it matches. If the previous drag's card is still
    // mounted — it reached the destination, so it carries exactly that text —
    // the loop matches the STALE card and returns before a single arrow key has
    // moved anything. `Space` then drops the drag where it still is, on the
    // SOURCE bed, and the dialog opens naming the wrong bed. Waiting on the card
    // to unmount is the ordering guarantee that makes that impossible; a longer
    // timeout would only narrow the window, and still drop on the wrong bed when
    // it lost. `dragCard()` is the right signal because the DragOverlay mounts it
    // only while a drag is live (#2905).
    async function startKeyboardDrag() {
      await expect(dragCard()).toBeHidden();
      await dragHandle().focus();
      await page.keyboard.press("Space");
    }

    // Keyboard preview + cancel: pickup and navigation are real key events.
    await startKeyboardDrag();
    await moveKeyboardFocusToDestination();
    await expect(preview()).toBeVisible();
    await page.keyboard.press("Escape");
    // Not a synchronisation point: `moveRequests` is already 1 from the pointer
    // phase, so this passes instantly. It is here as the assertion that cancel
    // sent no PATCH, and the `toBeHidden` in startKeyboardDrag is what actually
    // sequences the next drag behind this one.
    await expect.poll(() => moveRequests.length).toBe(1);
    persisted = await readPersisted();
    expect(
      persisted.every((allocation) => allocation.bedId === originalBedId),
    ).toBe(true);

    // Keyboard drop opens the same reviewed seam, still without a PATCH. Cancel
    // and prove focus returns to the originating drag handle.
    await startKeyboardDrag();
    await moveKeyboardFocusToDestination();
    await page.keyboard.press("Space");
    await expect(moveDialog).toBeVisible();
    expect(moveRequests).toHaveLength(1);
    await moveDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dragHandle()).toBeFocused();
    persisted = await readPersisted();
    expect(persisted.map((allocation) => allocation.stayDate)).toEqual(
      originalDates,
    );
    expect(
      persisted.every((allocation) => allocation.bedId === originalBedId),
    ).toBe(true);

    // The nested menu uses the same seam. Selecting the current bed keeps that
    // option reachable for person-scope consolidation; here every row is
    // already there, so confirm is a real typed all-noop request.
    const manageAllocation = page
      .getByRole("button", { name: "Manage allocation for Ken King" })
      .first();
    await manageAllocation.click();
    const sourceRoomMenu = page.getByRole("menuitem", {
      name: `Move Ken King to a bed in ${originalBed!.roomName}`,
    });
    await sourceRoomMenu.hover();
    await page
      .getByRole("menuitem", {
        name: `Move Ken King to ${originalBed!.roomName} / ${originalBed!.name}`,
      })
      .click();
    const noopDialog = page.getByRole("dialog", {
      name: new RegExp(
        `Move Ken King to ${originalBed!.roomName} / ${originalBed!.name}`,
      ),
    });
    await noopDialog
      .getByRole("radio", { name: /This person on this booking/ })
      .check();
    await expect(
      noopDialog.getByText(
        `0 changing, ${allocationIds.length} unchanged, ${allocationIds.length} total`,
        { exact: false },
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      noopDialog.getByText(/No allocation will change and no approval or audit record/),
    ).toBeVisible();
    await noopDialog.getByRole("button", { name: "Confirm move" }).click();
    await expect(noopDialog).toBeHidden({ timeout: 30_000 });
    expect(moveRequests).toHaveLength(2);
    expect(moveRequests[1]).toMatchObject({
      destinationBedId: originalBedId,
      scope: "BOOKING_GUEST",
    });
    expect(moveRequests[1]).not.toHaveProperty("stayDate");
    await expect(manageAllocation).toBeFocused();

  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    // A failure before the first drop has changed nothing, so cleanup must be a
    // no-op too. Once a page move was attempted, restore through the product's
    // allocation-scoped APIs: move back first (which re-drafts), then restore
    // only the stable ids that were approved on entry.
    if (moveRequests.length > 0) {
      let placementRestored = false;
      try {
        const restored = await adminContext.request.patch(
          "/api/admin/bed-allocation/allocations",
          {
            data: {
              allocationIds,
              bedId: originalBedId,
            },
          },
        );
        if (!restored.ok()) {
          throw new Error(
            `restore seeded bed (${restored.status()}): ${await restored.text()}`,
          );
        }
        placementRestored = true;
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (placementRestored && originalApprovedAllocationIds.length > 0) {
        try {
          // #2887: approve names its lodge, always — omitting it used to lock
          // every lodge plus the global key for rows at one.
          const restoredApproval = await adminContext.request.post(
            "/api/admin/bed-allocation/approve",
            {
              data: {
                allocationIds: originalApprovedAllocationIds,
                lodgeId: await resolveSingleActiveLodgeId(adminContext.request),
              },
            },
          );
          if (!restoredApproval.ok()) {
            throw new Error(
              `restore seeded approval (${restoredApproval.status()}): ${await restoredApproval.text()}`,
            );
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (scenarioError) {
        await testInfo
          .attach("bed-allocation-cleanup-errors", {
            body: cleanupErrors
              .map((error) =>
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              )
              .join("\n\n"),
            contentType: "text/plain",
          })
          .catch(() => undefined);
      } else {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation E2E fixture cleanup failed",
        );
      }
    }
  }
});

// High row (docs/END_TO_END_TEST_MATRIX.md): "Allocate and confirm beds from
// inside a booking" (#2252). Runs after the board test above, on the same
// serial fixture: Ken's guest is already on A1 and approved. A single-night
// move re-DRAFTS that row — one of the three ways drafts keep arising under
// #2251's auto-approve — and the in-booking Bed allocation panel then confirms
// it, which is the whole point of the booking-scoped approve selector.
test("an admin confirms this booking's beds from the booking page, and the member never sees the panel", async ({
  browser,
}) => {
  const ken = DEMO_BOOKING_WINDOWS.kenReview;

  // Resolve Ken's booking and a second bed from the board's own read, rather
  // than hard-coding ids the seed is free to change.
  const dashboard = await adminContext.request.get(
    `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  expect(dashboard.ok(), `read the board (${dashboard.status()})`).toBeTruthy();
  const payload = (await dashboard.json()) as {
    rooms: Array<{ active: boolean; beds: Array<{ id: string; active: boolean }> }>;
    allocations: Array<{
      bookingId: string;
      bookingGuestId: string;
      bedId: string;
      stayDate: string;
      guestName: string;
    }>;
  };
  const kensAllocation = payload.allocations.find((allocation) =>
    allocation.guestName.includes("Ken"),
  );
  expect(kensAllocation, "Ken is on a bed after the board test").toBeTruthy();

  const otherBed = payload.rooms
    .filter((room) => room.active)
    .flatMap((room) => room.beds)
    .find((bed) => bed.active && bed.id !== kensAllocation!.bedId);
  expect(otherBed, "a second active bed exists to move onto").toBeTruthy();

  // Moving an approved row clears its approval — the lock is not one-way.
  const moved = await adminContext.request.post(
    "/api/admin/bed-allocation/allocations",
    {
      data: {
        bookingGuestId: kensAllocation!.bookingGuestId,
        bedId: otherBed!.id,
        stayDate: kensAllocation!.stayDate,
      },
    },
  );
  expect(moved.ok(), `move Ken to a second bed (${moved.status()})`).toBeTruthy();

  // ── Confirm from inside the booking ──
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${kensAllocation!.bookingId}`);

  const panel = page.locator("#bed-allocation:visible");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Ken", { exact: false }).first()).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Open on the board" }),
  ).toBeVisible();

  const confirmButton = panel.getByRole("button", {
    name: "Confirm draft beds",
  });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByText(/Confirmed \d+ bed night/)).toBeVisible();
  // The panel refetches after the write: with nothing left in draft, Confirm
  // disables itself rather than offering a no-op.
  await expect(confirmButton).toBeDisabled({ timeout: 30_000 });
  await page.close();

  // ── The member never gets the panel ──
  // personas.booker is the only member persona with saved storage state, so it
  // is the only one that can actually sign in here.
  const memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });
  try {
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/bookings");
    await completeMemberDetailsGateIfShown(memberPage);
    // The whole booking card is one anchor (my-bookings-list.tsx), so target
    // the href rather than a label.
    const firstBooking = memberPage
      .locator('a[href^="/bookings/"]')
      .first();
    await expect(firstBooking).toBeVisible({ timeout: 30_000 });
    await firstBooking.click();
    await expect(memberPage).toHaveURL(/\/bookings\/[^/?]+/);
    await expect(memberPage.locator("#bed-allocation")).toHaveCount(0);
    await expect(
      memberPage.getByRole("heading", { name: "Bed allocation" }),
    ).toHaveCount(0);
    // …and not even the section-rail link (#2252 review). The rail used to be
    // built from every candidate anchor and pruned in an effect after mount, so
    // the member's server-rendered HTML really did carry a "Bed Allocation"
    // link for a moment. It is now filtered out server-side, so it is absent
    // from the very first paint — asserted on the rail's own <nav>, which is
    // where a pruned-after-hydration entry would still have flashed.
    await expect(
      memberPage
        .getByRole("navigation", { name: "On this page" })
        .getByRole("link", { name: "Bed Allocation" }),
    ).toHaveCount(0);
    await memberPage.close();
  } finally {
    await memberContext.close();
  }
});

// High row (issue #2594): Reset is deliberately category-neutral, while a
// row-triggered removal starts from that row's mutually-exclusive category.
// This serial step reuses Ken's approved allocation from the journeys above,
// applies the booking-panel flow, and proves that enabling auto allocation does
// not make Apply silently replace the removed row.
test("staged removal previews an approved booking row and leaves it unallocated", async ({}, testInfo) => {
  const ken = DEMO_BOOKING_WINDOWS.kenReview;
  const page = await adminContext.newPage();
  let scenarioError: unknown;
  let removalAttempted = false;
  let originalAllocations: Array<{
    id: string;
    bookingId: string;
    bookingGuestId: string;
    bedId: string;
    stayDate: string;
    guestName: string;
    approvedAt: string | null;
  }> = [];

  try {
    await page.goto(
      `/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
    );

  await page.getByRole("button", { name: /Reset allocations/ }).click();
  const resetDialog = page.getByRole("dialog", {
    name: "Remove bed allocations",
  });
  for (const category of ["Auto draft", "Manual draft", "Approved"]) {
    await expect(
      resetDialog.getByRole("checkbox", {
        name: new RegExp(`^${category}\\b`, "i"),
      }),
    ).not.toBeChecked();
  }
  await expect(
    resetDialog.getByRole("button", { name: "Preview removal" }),
  ).toBeDisabled();
  await resetDialog.getByRole("button", { name: "Cancel" }).click();

  const dashboard = await adminContext.request.get(
    `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  expect(dashboard.ok(), `read Ken's allocation (${dashboard.status()})`).toBeTruthy();
  const before = (await dashboard.json()) as {
    allocations: Array<{
      id: string;
      bookingId: string;
      bookingGuestId: string;
      bedId: string;
      stayDate: string;
      guestName: string;
      approvedAt: string | null;
    }>;
  };
  originalAllocations = before.allocations.filter(
    (allocation) =>
      allocation.guestName.includes("Ken") && allocation.approvedAt !== null,
  );
  const approvedKen = originalAllocations[0];
  expect(approvedKen, "Ken has one approved row to remove").toBeTruthy();

  // The board chip menu and the drag-to-unallocated-bucket gesture must open
  // this same reviewed flow. Cancel both previews before the destructive
  // booking-panel proof so neither entry point mutates the shared fixture.
  const manageAllocation = page
    .getByRole("button", { name: /Manage allocation for Ken King/ })
    .first();
  await manageAllocation.click();
  await page.getByRole("menuitem", { name: "Remove allocation" }).click();
  const boardRemovalDialog = page.getByRole("dialog", {
    name: "Remove bed allocations",
  });
  await expect(
    boardRemovalDialog.getByRole("checkbox", { name: /^Approved\b/i }),
  ).toBeChecked();
  await boardRemovalDialog.getByRole("button", { name: "Cancel" }).click();

  const dragHandle = page
    .getByRole("button", { name: /Drag Ken King to another bed/ })
    .first();
  const awaitingBucket = page.getByTestId(
    "bed-allocation-unallocated-bucket",
  );
  const [dragBox, bucketBox] = await Promise.all([
    dragHandle.boundingBox(),
    awaitingBucket.boundingBox(),
  ]);
  expect(dragBox, "Ken's allocation drag handle is visible").toBeTruthy();
  expect(bucketBox, "the unallocated bucket is visible").toBeTruthy();
  await page.mouse.move(
    dragBox!.x + dragBox!.width / 2,
    dragBox!.y + dragBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bucketBox!.x + bucketBox!.width / 2,
    bucketBox!.y + bucketBox!.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect(boardRemovalDialog).toBeVisible();
  await expect(
    boardRemovalDialog.getByRole("checkbox", { name: /^Approved\b/i }),
  ).toBeChecked();
  await boardRemovalDialog.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`/bookings/${approvedKen!.bookingId}`);
  const panel = page.locator("#bed-allocation:visible");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await panel
    .getByRole("button", { name: "Remove", exact: true })
    .first()
    .click();

  const removalDialog = page.getByRole("dialog", {
    name: "Remove bed allocations",
  });
  await expect(
    removalDialog.getByRole("checkbox", { name: /^Approved\b/i }),
  ).toBeChecked();
  await expect(
    removalDialog.getByText("Approved beds will be removed"),
  ).toBeVisible();
  await removalDialog.getByLabel("Removal scope").click();
  await page
    .getByRole("option", {
      name: "This person on this booking, including off-screen nights",
    })
    .click();
  await removalDialog
    .getByRole("button", { name: "Preview removal" })
    .click();
  await expect(
    removalDialog.getByText("Preview ready: 2 allocations will be removed."),
  ).toBeVisible();
  await expect(
    removalDialog.getByText("Requested-room editing will re-open"),
  ).toBeVisible();

  await setBedAllocationSettings(adminContext.request, {
    ...bedAllocationSettingsBefore!,
    autoAllocationEnabled: true,
  });
  removalAttempted = true;
  await removalDialog
    .getByRole("button", { name: "Remove reviewed allocations" })
    .click();
  await expect(
    page.getByText(
      "2 reviewed bed nights removed for this booking; no automatic allocation was run",
    ),
  ).toBeVisible();
  await expect(panel.getByText("No bed on any night of this page.")).toBeVisible();

  const afterResponse = await adminContext.request.get(
    `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  expect(
    afterResponse.ok(),
    `re-read Ken's allocation (${afterResponse.status()})`,
  ).toBeTruthy();
  const after = (await afterResponse.json()) as {
    allocations: Array<{ bookingId: string }>;
  };
  expect(
    after.allocations.some(
      (allocation) => allocation.bookingId === approvedKen!.bookingId,
    ),
    "reviewed removal must not auto-create a replacement row",
  ).toBe(false);
  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (removalAttempted && originalAllocations.length > 0) {
      try {
        const currentResponse = await adminContext.request.get(
          `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
        );
        if (!currentResponse.ok()) {
          throw new Error(
            `read removal cleanup state (${currentResponse.status()}): ${await currentResponse.text()}`,
          );
        }
        const current = (await currentResponse.json()) as {
          allocations: Array<{
            id: string;
            bookingGuestId: string;
            stayDate: string;
            approvedAt: string | null;
          }>;
        };
        const currentByGuestNight = new Map(
          current.allocations.map((allocation) => [
            `${allocation.bookingGuestId}:${allocation.stayDate}`,
            allocation,
          ]),
        );
        const restoredAllocationIds: string[] = [];
        for (const allocation of originalAllocations) {
          const currentAllocation = currentByGuestNight.get(
            `${allocation.bookingGuestId}:${allocation.stayDate}`,
          );
          if (currentAllocation) {
            if (currentAllocation.approvedAt === null) {
              restoredAllocationIds.push(currentAllocation.id);
            }
            continue;
          }
          const restored = await adminContext.request.post(
            "/api/admin/bed-allocation/allocations",
            {
              data: {
                bookingGuestId: allocation.bookingGuestId,
                bedId: allocation.bedId,
                stayDate: allocation.stayDate,
              },
            },
          );
          if (!restored.ok()) {
            throw new Error(
              `restore removed bed night ${allocation.stayDate} (${restored.status()}): ${await restored.text()}`,
            );
          }
          const body = (await restored.json()) as {
            allocation: { id: string };
          };
          restoredAllocationIds.push(body.allocation.id);
        }
        if (restoredAllocationIds.length > 0) {
          const restoredApproval = await adminContext.request.post(
            "/api/admin/bed-allocation/approve",
            {
              data: {
                allocationIds: restoredAllocationIds,
                lodgeId: await resolveSingleActiveLodgeId(adminContext.request),
              },
            },
          );
          if (!restoredApproval.ok()) {
            throw new Error(
              `restore removed approvals (${restoredApproval.status()}): ${await restoredApproval.text()}`,
            );
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (scenarioError) {
        await testInfo
          .attach("bed-allocation-removal-cleanup-errors", {
            body: cleanupErrors
              .map((error) =>
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              )
              .join("\n\n"),
            contentType: "text/plain",
          })
          .catch(() => undefined);
      } else {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation removal E2E fixture cleanup failed",
        );
      }
    }
  }
});
