"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/admin/back-link";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { AdminViewOnlyNotice } from "@/components/admin/view-only-action";
import {
  emptyBuilderModel,
  parseBuilderModel,
  type BuilderModel,
} from "@/lib/lodge-display/builder-model";
import {
  isBuiltInDisplayLayoutKey,
  isBuiltInDisplayTemplateKey,
} from "@/lib/lodge-display/built-in-seeds";
import { DISPLAY_TERM_BOARD } from "@/lib/lodge-display/display-terminology";
import DisplayBuilder from "./display-builder";
import { getAdminPage } from "@/lib/admin-hubs";

// Visual builder surface (ADR-004 §1/§4). A NEW board is composed from a blank
// skeleton; an EXISTING template opens here only when its Layout carries the
// dlb-root signature AND round-trips (parseBuilderModel). A hand-authored or
// advanced-broken layout degrades to Advanced-only with a clear banner + a
// "Rebuild in builder (replaces the body)" escape hatch — never silently
// reinterpreted (ADR-004 §4).

interface LoadedTemplate {
  id: string;
  key: string;
  name: string;
  layout: {
    id: string;
    // The layout's own key — a CUSTOM template can be bound to a BUILT-IN layout,
    // which is read-only server-side, so the Advanced-only branch must check this
    // too and never offer a Rebuild whose layout PUT would 409 (#2048 E).
    key: string;
    bodyHtml: string;
    defaultCss: string;
    areas: unknown;
  };
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

type Loaded =
  | { status: "loading" }
  | { status: "new" }
  | {
      status: "open";
      layoutId: string | null;
      templateId: string | null;
      model: BuilderModel;
      key: string;
      name: string;
      footerHtml: string;
      cssOverrides: string;
      defaultCssCustomised: boolean;
      isBuiltIn: boolean;
    }
  | {
      status: "advanced-only";
      templateId: string;
      loaded: LoadedTemplate;
    }
  | { status: "error"; message: string };

function readTemplateId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("templateId");
}

export default function DisplayBuilderPage() {
  const canEdit = useAdminAreaEditAccess("lodge");
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [lodges, setLodges] = useState<{ id: string; name: string }[]>([]);
  // A "Rebuild in builder" click forces a fresh skeleton while keeping the ids so
  // Save overwrites the same rows (ADR-004 §4).
  const [rebuild, setRebuild] = useState(false);
  // A built-in reaches the builder only as Advanced-only (built-ins never carry the
  // dlb-root signature). Rebuilding one can never save (the row is read-only), so a
  // built-in offers "Duplicate to customise" instead, which opens a fresh, editable
  // create seeded from the built-in's name/key (§U1).
  const [duplicate, setDuplicate] = useState(false);

  const load = useCallback(async () => {
    const lodgesRes = await fetch("/api/admin/lodges").catch(() => null);
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json()) as {
        lodges?: Array<{ id: string; name: string; active?: boolean }>;
      };
      setLodges(
        (body.lodges ?? [])
          .filter((l) => l.active !== false)
          .map((l) => ({ id: l.id, name: l.name }))
      );
    } else {
      setLodges([]);
      setState({
        status: "error",
        message:
          "Could not load the lodge list. The builder is stopped because a preview must have an explicit lodge.",
      });
      return;
    }

    const templateId = readTemplateId();
    if (!templateId) {
      setState({ status: "new" });
      return;
    }
    const res = await fetch(`/api/admin/display/templates/${templateId}`);
    if (!res.ok) {
      setState({ status: "error", message: "Could not load that board." });
      return;
    }
    const body = (await res.json()) as { template: LoadedTemplate };
    const t = body.template;
    const parsed = parseBuilderModel({
      bodyHtml: t.layout.bodyHtml,
      defaultCss: t.layout.defaultCss,
      areas: t.layout.areas,
      slotContent: t.slotContent,
    });
    if (parsed.ok) {
      setState({
        status: "open",
        layoutId: t.layout.id,
        templateId: t.id,
        model: parsed.model,
        key: t.key,
        name: t.name,
        footerHtml: t.footerHtml,
        cssOverrides: t.cssOverrides,
        defaultCssCustomised: parsed.defaultCssCustomised,
        isBuiltIn: isBuiltInDisplayTemplateKey(t.key),
      });
    } else {
      setState({ status: "advanced-only", templateId: t.id, loaded: t });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <BackLink href="/admin/display" label="Lobby Display" />
        <h1 className="mt-2 text-2xl font-bold">{getAdminPage("display-builder").label}</h1>
        <p className="text-muted-foreground text-sm">
          {/* #2247: "board" is the operator-facing word for what a screen
              shows, so say what it is the first time this page uses it. The
              definition is the one on the hub and the Reference page. */}
          {DISPLAY_TERM_BOARD.oneLiner} Compose one by picking a shape and
          dropping modules into zones. No HTML required — the builder writes a
          valid Layout and Template for you. For full control, use{" "}
          <Link className="underline" href="/admin/display/layouts">
            Advanced mode
          </Link>
          .
        </p>
      </div>

      {!canEdit && (
        <AdminViewOnlyNotice canEdit={canEdit}>
          Your admin role can view the visual builder but cannot save. Lodge edit
          access is required to author a board.
        </AdminViewOnlyNotice>
      )}

      {state.status === "loading" && <p className="text-muted-foreground text-sm">Loading…</p>}

      {state.status === "error" && (
        <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-3 rounded-md border p-3 text-sm">
          <p>{state.message}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      )}

      {state.status === "advanced-only" &&
        !rebuild &&
        !duplicate &&
        (isBuiltInDisplayTemplateKey(state.loaded.key) ? (
          // A built-in TEMPLATE is code-managed and read-only, so Rebuild-then-Save
          // could never persist. Offer a real fork instead: duplicate into a fresh,
          // editable board in the builder (§U1).
          <div className="space-y-3 rounded-md border border-warning-7/50 bg-warning-3 p-4 text-sm text-warning-11">
            <p className="font-medium">This is a built-in design.</p>
            <p>
              Built-ins are refreshed from code on every upgrade, so the builder
              can&apos;t save over one. They also aren&apos;t opened for direct
              editing here. To customise it, duplicate it into a new board — you
              can then compose and save your copy in the builder. The built-in is
              left untouched. You can also inspect it in{" "}
              <Link className="underline" href="/admin/display/templates">
                Advanced mode
              </Link>
              .
            </p>
            <p>
              Duplicating here starts a <strong>blank</strong> board (the built-in
              body can&apos;t open in the builder). To keep the built-in&apos;s
              existing design, use <strong>Duplicate to customise</strong> in{" "}
              <Link className="underline" href="/admin/display/templates">
                Advanced mode
              </Link>{" "}
              instead, which copies its content.
            </p>
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => setDuplicate(true)}
            >
              Duplicate to customise
            </Button>
          </div>
        ) : isBuiltInDisplayLayoutKey(state.loaded.layout.key) ? (
          // A CUSTOM template bound to a BUILT-IN layout: the template itself is
          // editable, but its layout is read-only server-side, so Rebuild (which
          // re-saves the layout body) would 409 with a message blaming the wrong
          // entity. Offer the paths that actually work instead — never Rebuild
          // (#2048 E).
          <div className="space-y-3 rounded-md border border-warning-7/50 bg-warning-3 p-4 text-sm text-warning-11">
            <p className="font-medium">
              This board&apos;s layout is a built-in.
            </p>
            <p>
              The board itself is custom, but it is built on a built-in layout,
              which is refreshed from code on every upgrade and is read-only — so
              the builder can&apos;t rebuild and save over it. To adjust the
              content and styling in place, edit it in{" "}
              <Link className="underline" href="/admin/display/templates">
                Advanced mode
              </Link>
              . To get a fully builder-editable board, duplicate it into a new
              board (a fresh layout and template you own).
            </p>
            <p>
              Duplicating here starts a <strong>blank</strong> board. To keep the
              existing design, use <strong>Duplicate to customise</strong> in
              Advanced mode instead, which copies its content.
            </p>
            <Button
              variant="outline"
              disabled={!canEdit}
              onClick={() => setDuplicate(true)}
            >
              Duplicate to customise
            </Button>
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-warning-7/50 bg-warning-3 p-4 text-sm text-warning-11">
            <p className="font-medium">This board can&apos;t be opened in the visual builder.</p>
            <p>
              It was hand-edited (or built with a different layout idiom), so the
              builder can&apos;t safely reinterpret it. Edit it in{" "}
              <Link className="underline" href="/admin/display/templates">
                Advanced mode
              </Link>
              , or rebuild it in the builder — which <strong>replaces the layout
              body</strong> with a fresh skeleton (your current body is discarded).
            </p>
            <Button variant="outline" disabled={!canEdit} onClick={() => setRebuild(true)}>
              Rebuild in builder (replaces the body)
            </Button>
          </div>
        ))}

      {state.status === "new" && (
        <DisplayBuilder
          layoutId={null}
          templateId={null}
          initialModel={emptyBuilderModel("side-rail", 2)}
          initialKey=""
          initialName=""
          initialFooterHtml=""
          initialCssOverrides=""
          isBuiltIn={false}
          canEdit={canEdit}
          lodges={lodges}
          onDuplicate={() => undefined}
        />
      )}

      {state.status === "open" && (
        <DisplayBuilder
          layoutId={state.layoutId}
          templateId={state.templateId}
          initialModel={state.model}
          initialKey={state.key}
          initialName={state.name}
          initialFooterHtml={state.footerHtml}
          initialCssOverrides={state.cssOverrides}
          isBuiltIn={state.isBuiltIn}
          canEdit={canEdit}
          lodges={lodges}
          defaultCssCustomised={state.defaultCssCustomised}
          onDuplicate={() => {
            // Fork to a new pair: clear the ids + suffix the key/name (mirrors the
            // existing duplicate-to-customise fork), so Save creates fresh rows.
            setState({
              status: "open",
              layoutId: null,
              templateId: null,
              model: state.model,
              key: `${state.key}-copy`,
              name: `${state.name} (copy)`,
              defaultCssCustomised: false,
              cssOverrides: state.cssOverrides,
              footerHtml: state.footerHtml,
              isBuiltIn: false,
            });
          }}
        />
      )}

      {state.status === "advanced-only" && rebuild && (
        // Rebuild keeps the same row ids so Save overwrites in place. Only a
        // NON-built-in reaches here (built-ins take the duplicate path), so this is
        // never a read-only row — isBuiltIn is false.
        <DisplayBuilder
          layoutId={state.loaded.layout.id}
          templateId={state.loaded.id}
          initialModel={emptyBuilderModel("side-rail", 2)}
          initialKey={state.loaded.key}
          initialName={state.loaded.name}
          initialFooterHtml={state.loaded.footerHtml}
          initialCssOverrides={state.loaded.cssOverrides}
          isBuiltIn={false}
          canEdit={canEdit}
          lodges={lodges}
          onDuplicate={() => undefined}
        />
      )}

      {state.status === "advanced-only" && duplicate && (
        // Fork a built-in into a NEW editable board: no row ids (Save creates fresh
        // rows), a suffixed key/name, and a fresh skeleton (the built-in body can't
        // be reinterpreted). The author lands editable — the fix for the dead-end
        // Rebuild path (§U1).
        <DisplayBuilder
          layoutId={null}
          templateId={null}
          initialModel={emptyBuilderModel("side-rail", 2)}
          initialKey={`${state.loaded.key}-copy`}
          initialName={`${state.loaded.name} (copy)`}
          initialFooterHtml={state.loaded.footerHtml}
          initialCssOverrides={state.loaded.cssOverrides}
          isBuiltIn={false}
          canEdit={canEdit}
          lodges={lodges}
          onDuplicate={() => undefined}
        />
      )}
    </div>
  );
}
