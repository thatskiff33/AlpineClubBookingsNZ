"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MEMBER_GUEST_FIND_COPY,
  MEMBER_GUEST_SEARCH_MIN_CHARS,
  classifyMemberGuestFindInput,
  describeHouseholdCandidatePrompt,
  hasIndistinguishableMemberGuestCandidates,
  shouldAutoResolveMemberGuestCandidate,
  type MemberGuestCandidate,
  type MemberGuestCandidateResponse,
} from "@/lib/member-guest-find";

/**
 * The inline "+ Add Member Guest" find panel (epic #2305, MG3 #2308).
 *
 * **INLINE, NOT A DIALOG** — owner sign-off answer 3, and the reason it is worth
 * stating: the booker keeps sight of their existing guests and the guest limit
 * while they search, and a pop-up inside a multi-step form is awkward on a phone
 * and a known trap for keyboard and screen-reader users.
 *
 * **ONE BOX THAT TAKES EITHER** — owner sign-off answer 2. If what the member
 * typed parses as an email address it is resolved exactly by the email path;
 * otherwise, and only where the club has turned open search on, it searches
 * names. There is no mode switch. With open search OFF the box is an email box,
 * says so, and — since the UX review's finding F7 — TELLS the member when they
 * type a name instead of silently doing nothing.
 *
 * **THE KEYBOARD CONTRACT, which is the same in both modes.** The UX review
 * found the pick-list unusable by keyboard in the DEFAULT configuration: an
 * `isEmailIntent && Enter` branch sat above candidate selection and always won,
 * so Enter re-ran the lookup instead of choosing the highlighted row and there
 * was no workaround at all. The rule now is one sentence: **if there are
 * candidates on screen, Enter chooses the highlighted one; otherwise Enter runs
 * the find.** Arrow keys move the highlight, Escape backs out. Both modes, one
 * behaviour, and the ARIA below is likewise not conditional on which mode is
 * live — the household pick-list renders in email mode too, and gating the
 * combobox attributes on `openSearchEnabled` left it an unannounced orphan in
 * the configuration every club ships with (F2).
 *
 * WHAT THIS COMPONENT MAY NOT DO, and it is a short list because the server
 * enforces all of it anyway: it must not filter candidates on anything the
 * server did not filter on (that would be a client-side eligibility rule the
 * server does not share), and it must not show a member anything beyond the four
 * fields the server sent. The only client-side judgement here is DISABLING (never
 * hiding) rows for people already in the party — which the server deliberately
 * does not do, because filtering them out server-side would leak "this person is
 * already on your booking" by absence.
 */

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Where the panel asks its two questions.
 *
 * ADDED BY MG4 (#2309) SO THE PANEL ITSELF STAYS UNCHANGED. The admin picker
 * needs the same state machine, the same keyboard contract, the same copy and
 * the same fixed-envelope handling as the member one — it differs only in which
 * route answers, because an officer's lookup is gated and audited differently
 * (see the admin route's own note). Parameterising the two fetches, rather than
 * branching inside the component on "am I an admin?", keeps every behavioural
 * rule in one implementation: there is no admin variant of the panel that could
 * drift, only an admin pair of URLs.
 *
 * Each returns the raw `Response` because the panel's STATUS handling is part
 * of its contract — 429 means rate limited, 400 in email mode reads as a miss,
 * anything else non-ok is the ordinary failure — and moving that into the
 * transport would be exactly the kind of split-brain this seam exists to avoid.
 */
export interface MemberGuestFindEndpoints {
  resolveByEmail(email: string, signal: AbortSignal): Promise<Response>;
  searchByName(q: string, signal: AbortSignal): Promise<Response>;
}

/** The member-facing routes: what every caller before MG4 used, unchanged. */
export const MEMBER_GUEST_FIND_ENDPOINTS: MemberGuestFindEndpoints = {
  resolveByEmail: (email, signal) =>
    fetch("/api/members/guest-candidates/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      signal,
    }),
  searchByName: (q, signal) =>
    fetch(`/api/members/guest-candidates/search?q=${encodeURIComponent(q)}`, {
      signal,
    }),
};

/**
 * The admin picker's routes (MG4 #2309), scoped to the booking being edited.
 *
 * One route, two modes — see its own doc comment for why the name mode needs
 * `membership:view` and the email mode does not.
 *
 * THE EMAIL LOOKUP IS A POST, matching the member pair above rather than
 * diverging from it. An address in a query string lands in the access log, the
 * browser history and the `Referer` of every later request from the page; a body
 * lands in none of those. The member route's docblock calls the method
 * load-bearing, and nothing about an officer typing the address makes it less so.
 */
export function adminMemberGuestFindEndpoints(
  bookingId: string,
): MemberGuestFindEndpoints {
  const base = `/api/admin/bookings/${encodeURIComponent(bookingId)}/member-guest-candidates`;
  return {
    resolveByEmail: (email, signal) =>
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
        signal,
      }),
    searchByName: (q, signal) =>
      fetch(`${base}?q=${encodeURIComponent(q)}`, { signal }),
  };
}

export interface MemberGuestFindPanelProps {
  /** Whether the name type-ahead is available to this reader. Decoration only — the routes re-check. */
  openSearchEnabled: boolean;
  /** Defaults to the member-facing routes; the admin picker passes its own. */
  endpoints?: MemberGuestFindEndpoints;
  /** Member ids already in the party, so their rows render disabled rather than vanishing. */
  existingMemberIds: readonly string[];
  /** True when the party is already at the lodge capacity. */
  atCapacity: boolean;
  onAdd: (candidate: MemberGuestCandidate) => void;
  onCancel: () => void;
  /**
   * The server's refusal after "Add to booking", if there was one. D-8 neutral:
   * one sentence, whatever the real reason.
   */
  addError?: string | null;
  /**
   * Who the refused add was about, so the message can be shown beneath a chip
   * naming them rather than floating above an empty search box (F9). The add
   * closes the panel and the answer arrives on the quote that follows, so the
   * panel's own `selected` is long gone by then.
   */
  refusedCandidate?: MemberGuestCandidate | null;
}

type PanelState =
  | { kind: "IDLE" }
  // Carries the results it is replacing, so a narrowing type-ahead does not
  // blink its list out on every keystroke (F15).
  | { kind: "LOADING"; previous?: MemberGuestCandidateResponse; mode: "EMAIL" | "NAME" }
  | { kind: "RESULTS"; response: MemberGuestCandidateResponse; mode: "EMAIL" | "NAME" }
  | { kind: "MESSAGE"; text: string }
  | { kind: "RATE_LIMITED" }
  | { kind: "ERROR" };

export function MemberGuestFindPanel({
  openSearchEnabled,
  endpoints = MEMBER_GUEST_FIND_ENDPOINTS,
  existingMemberIds,
  atCapacity,
  onAdd,
  onCancel,
  addError,
  refusedCandidate,
}: MemberGuestFindPanelProps) {
  const [text, setText] = useState("");
  const [state, setState] = useState<PanelState>({ kind: "IDLE" });
  const [selected, setSelected] = useState<MemberGuestCandidate | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputId = useId();
  const listboxId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // One controller per keystroke, aborted by the next — mirrors
  // address-autocomplete.tsx, and it is what stops a slow early request landing
  // on top of a fast later one and showing results for a query the member has
  // already typed past.
  const abortRef = useRef<AbortController | null>(null);

  const intent = classifyMemberGuestFindInput(text);
  const nameQuery = intent.kind === "NAME" ? intent.q.trim() : "";
  const nameTooShort =
    intent.kind === "NAME" && nameQuery.length < MEMBER_GUEST_SEARCH_MIN_CHARS;

  async function runEmailResolve(email: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ kind: "LOADING", mode: "EMAIL" });
    try {
      const res = await endpoints.resolveByEmail(email, controller.signal);
      if (res.status === 429) {
        setState({ kind: "RATE_LIMITED" });
        return;
      }
      if (res.status === 400) {
        // The route re-parses with zod's own email rule, which is stricter than
        // this component's "does it look like an address?" test — `sam@a.co.nz.`
        // passes here and fails there. Showing "that didn't work" for a typing
        // mistake is both unhelpful and a needless third answer; a malformed
        // address says nothing about any member, so it gets the SAME fixed
        // sentence a genuine miss gets (correctness review, LOW-3).
        setState({ kind: "RESULTS", response: { candidates: [] }, mode: "EMAIL" });
        return;
      }
      if (!res.ok) {
        // Includes the module-off 404. There is nothing useful to say and
        // nothing safe to infer, so it reads as the ordinary failure it is.
        setState({ kind: "ERROR" });
        return;
      }
      const response = (await res.json()) as MemberGuestCandidateResponse;
      setState({ kind: "RESULTS", response, mode: "EMAIL" });
      setActiveIndex(0);
      if (shouldAutoResolveMemberGuestCandidate(response)) {
        chooseCandidate(response.candidates[0]!);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({ kind: "ERROR" });
    }
  }

  async function runNameSearch(q: string) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState((current) => ({
      kind: "LOADING",
      mode: "NAME",
      previous: current.kind === "RESULTS" ? current.response : undefined,
    }));
    try {
      const res = await endpoints.searchByName(q, controller.signal);
      if (res.status === 429) {
        setState({ kind: "RATE_LIMITED" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "ERROR" });
        return;
      }
      const response = (await res.json()) as MemberGuestCandidateResponse;
      setState({ kind: "RESULTS", response, mode: "NAME" });
      setActiveIndex(0);
      if (shouldAutoResolveMemberGuestCandidate(response)) {
        chooseCandidate(response.candidates[0]!);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setState({ kind: "ERROR" });
    }
  }

  // The name type-ahead. Debounced, aborted per keystroke, and only ever
  // mounted when the club turned open search on.
  //
  // THE TWO-CHARACTER FLOOR IS ENFORCED HERE, NOT ONLY ON THE SERVER (F6).
  // Without it, typing "s" fired a real `/search?q=s`, spent both rate-limit
  // buckets, wrote an audit row, and came back with "No members match that
  // name." — which is untrue: it means the query was too short. The server keeps
  // its own floor; this one stops the request being made at all.
  useEffect(() => {
    if (!openSearchEnabled) return;
    if (selected) return;
    if (intent.kind !== "NAME") return;
    if (nameTooShort) {
      setState({ kind: "MESSAGE", text: MEMBER_GUEST_FIND_COPY.minChars });
      return;
    }

    const q = nameQuery;
    const timer = setTimeout(() => {
      void runNameSearch(q);
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `intent` is derived from `text`; depending on the raw string keeps the
    // effect from re-running on every render for an unchanged query.
  }, [text, openSearchEnabled, selected, intent.kind, nameQuery, nameTooShort]);

  const candidates =
    state.kind === "RESULTS"
      ? state.response.candidates
      : state.kind === "LOADING" && state.previous
        ? state.previous.candidates
        : ([] as MemberGuestCandidate[]);
  // Carried across the in-flight window in exactly the way `candidates` is, and
  // for the same reason (#2460 review). `runNameSearch` flips the panel to
  // LOADING before the request resolves, so a flag read only from RESULTS would
  // collapse to false while the truncated list it describes is still the list on
  // screen: the hint blinked out from under a list that had not changed, and
  // came back a moment later. Read from the same place the rows are read from
  // and the sentence stays with the rows it is about.
  const truncated =
    state.kind === "RESULTS"
      ? state.response.truncated === true
      : state.kind === "LOADING" && state.previous
        ? state.previous.truncated === true
        : false;
  const alreadyAdded = new Set(existingMemberIds);
  const isLoading = state.kind === "LOADING";
  const listMode =
    state.kind === "RESULTS" || state.kind === "LOADING" ? state.mode : null;

  /**
   * Select a candidate — including one already in the party.
   *
   * An already-added row used to be a dead click, and auto-resolve bypassed this
   * function entirely, so resolving somebody already on the booking produced a
   * chip with a disabled "Add to booking" and no reason anywhere (F16). Both
   * paths now come through here and the chip carries the reason.
   */
  function chooseCandidate(candidate: MemberGuestCandidate) {
    setSelected(candidate);
  }

  function reset() {
    setSelected(null);
    setState({ kind: "IDLE" });
    setText("");
    inputRef.current?.focus();
  }

  /** What the Find button and a bare Enter both do. One place, both modes. */
  function runFind() {
    if (intent.kind === "EMPTY") return;
    if (intent.kind === "EMAIL") {
      if (!intent.wellFormed) {
        // Half an address is a typing mistake, not a fact about any member, so
        // it is answered locally with the SAME sentence a real miss produces. No
        // request is made, and nothing distinguishes the two for the member.
        setState({ kind: "RESULTS", response: { candidates: [] }, mode: "EMAIL" });
        return;
      }
      void runEmailResolve(intent.email);
      return;
    }
    if (!openSearchEnabled) {
      setState({ kind: "MESSAGE", text: MEMBER_GUEST_FIND_COPY.nameSearchOff });
      return;
    }
    if (nameTooShort) {
      setState({ kind: "MESSAGE", text: MEMBER_GUEST_FIND_COPY.minChars });
      return;
    }
    // An explicit press runs the query now rather than restarting the debounce.
    void runNameSearch(nameQuery);
  }

  /**
   * Escape, handled on the PANEL rather than on the input.
   *
   * Once a chip is showing there is no input to press Escape in — it is replaced
   * by the chip — so an Escape handler bound to the input could never reach its
   * own "clear the selection first" branch. On the container it works from
   * wherever focus happens to be, which is the whole point of an escape hatch.
   */
  function handlePanelKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (selected) {
      reset();
      return;
    }
    onCancel();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && candidates.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, candidates.length - 1));
      return;
    }
    if (event.key === "ArrowUp" && candidates.length > 0) {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      // Candidates on screen win over re-running the find — see the keyboard
      // contract in the file docblock.
      if (candidates.length > 0) {
        const candidate = candidates[activeIndex];
        if (candidate) chooseCandidate(candidate);
        return;
      }
      runFind();
    }
  }

  const label = openSearchEnabled
    ? MEMBER_GUEST_FIND_COPY.eitherLabel
    : MEMBER_GUEST_FIND_COPY.emailLabel;
  const hint = openSearchEnabled
    ? MEMBER_GUEST_FIND_COPY.eitherHint
    : MEMBER_GUEST_FIND_COPY.emailHint;

  const emptyResultText =
    state.kind === "RESULTS" && candidates.length === 0
      ? state.mode === "EMAIL"
        ? MEMBER_GUEST_FIND_COPY.noEmailMatch
        : MEMBER_GUEST_FIND_COPY.noNameMatch
      : null;
  const messageText = state.kind === "MESSAGE" ? state.text : emptyResultText;

  const disabledReason = selected
    ? alreadyAdded.has(selected.memberId)
      ? MEMBER_GUEST_FIND_COPY.alreadyAdded
      : atCapacity
        ? MEMBER_GUEST_FIND_COPY.atCapacity
        : null
    : null;

  /**
   * Whether the pick-list is on screen, and whether it carries the hint.
   *
   * `showCandidateList` is declared once and used BOTH as the gate on the
   * pick-list block below and as the first half of the truncation gate (#2460
   * review). The two used to state the same conditions separately, which left
   * the announcement free to drift away from the list it describes: change what
   * puts rows on screen and the status line would have gone on saying "Keep
   * typing to narrow this down." about a list that was no longer being drawn.
   *
   * `showTruncationHint` then drives the sentence the booker reads under the
   * list AND the sentence a screen reader hears on the end of the count, so the
   * two can never come to disagree about whether the list was cut short — which
   * is the whole failure the announcement exists to fix.
   */
  const showCandidateList = !selected && candidates.length > 1;
  const showTruncationHint = showCandidateList && truncated;

  // Everything the panel says out loud. A result count that changes silently is
  // unusable under a screen reader, and so is a zero-result answer — which used
  // to announce the empty string (F4).
  //
  // THE TRUNCATION HINT IS ANNOUNCED FROM HERE (#2460), on the end of the count
  // it qualifies, rather than from a live region of its own. It used to be a
  // bare paragraph under the list: a booker who had just typed heard "10 members
  // found" and then nothing, so the one fact that explains why the list stopped
  // — and the one action that fixes it — never reached them.
  //
  // A SECOND region was the obvious way to add it and is the wrong one. This
  // paragraph is already the panel's permanently-mounted `aria-live="polite"`
  // region, which is exactly the shape the house rule asks for (`AGENTS.md`, and
  // the #2244 export-truncation notice in `promo-redemptions-panel.tsx`: the
  // wrapper is mounted before there is anything to say, because a polite region
  // injected already-populated is silently dropped by some
  // screen-reader/browser pairings). Adding another one beside it would make
  // the panel say the sentence twice — and, worse, race: two polite regions
  // mutating in the same commit are queued in no guaranteed order, and
  // VoiceOver is known to drop one of them, which would have left the fix
  // announcing the count and swallowing the caveat. The repo treats the double
  // utterance as a defect in its own right, too
  // (`hut-leaders/_components/assignment-form.tsx` grew a prop purely to stop
  // two regions saying the same thing). One region, one utterance, in the order
  // the booker met the facts.
  //
  // The sentence is still reachable TWICE in browse mode — here, ahead of the
  // list, and again as the visible paragraph under it — and that is deliberate
  // (#2460 review). `aria-hidden` on the visible hint would collapse it to one
  // node; it was considered and rejected, because the visible hint is the copy
  // anchored to the place the list stops, and hiding on-screen text from
  // assistive technology to tidy a duplicate trades a real loss for a cosmetic
  // gain. Two static nodes an entire pick-list apart is not the defect; two
  // live regions would be.
  //
  // The sentence still never grows a count of who was LEFT OUT: the number here
  // is the number of members being shown, which this line already announced.
  const announcement = isLoading
    ? MEMBER_GUEST_FIND_COPY.searching
    : selected
      ? `Selected ${selected.firstName} ${selected.lastName}${
          disabledReason ? `. ${disabledReason}` : ""
        }`
      : messageText
        ? messageText
        : candidates.length === 0
          ? ""
          : `${candidates.length} member${candidates.length === 1 ? "" : "s"} found${
              showTruncationHint ? `. ${MEMBER_GUEST_FIND_COPY.truncated}` : ""
            }`;

  return (
    <div
      className="space-y-3 rounded-lg border border-primary p-4"
      data-testid="member-guest-find-panel"
      onKeyDown={handlePanelKeyDown}
    >
      {selected ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary bg-card px-3 py-3">
          <span className="font-semibold">
            {selected.firstName} {selected.lastName}
          </span>
          <span className="rounded-md border border-border px-2 py-0.5 text-xs font-semibold">
            {ageTierLabel(selected.ageTier)}
          </span>
          {disabledReason && (
            <span className="text-xs text-muted-foreground">{disabledReason}</span>
          )}
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Change
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={Boolean(disabledReason)}
            onClick={() => onAdd(selected)}
          >
            Add to booking
          </Button>
        </div>
      ) : (
        <div>
          <Label htmlFor={inputId}>{label}</Label>
          <div className="mt-1.5 flex items-end gap-2">
            <Input
              id={inputId}
              ref={inputRef}
              type="text"
              inputMode={openSearchEnabled ? "text" : "email"}
              autoComplete="off"
              value={text}
              placeholder={openSearchEnabled ? "name or email address" : "their email address"}
              onChange={(event) => {
                setText(event.target.value);
                // The name type-ahead drives its own state from the effect; every
                // other mode's result belongs to the text that produced it.
                if (!openSearchEnabled || classifyMemberGuestFindInput(event.target.value).kind !== "NAME") {
                  setState({ kind: "IDLE" });
                }
              }}
              onKeyDown={handleKeyDown}
              // NOT conditional on the mode (F2): the household pick-list
              // renders in email mode too, which is the default every club gets.
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={candidates.length > 0}
              aria-controls={candidates.length > 0 ? listboxId : undefined}
              aria-activedescendant={
                candidates.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined
              }
              aria-describedby={statusId}
            />
            {/* Always rendered, in both modes, so the input does not resize
                mid-typing the instant an "@" appears or disappears (F18). */}
            <Button
              type="button"
              onClick={runFind}
              disabled={intent.kind === "EMPTY" || isLoading}
            >
              Find
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
        </div>
      )}

      {/* Result-count changes are announced, not only drawn: a type-ahead whose
          list silently changes under a screen reader is unusable. Mounted
          unconditionally and empty until there is something to say — see the
          `announcement` docblock for why this is the panel's ONLY live region,
          truncation hint included (#2460). */}
      <p
        id={statusId}
        aria-live="polite"
        className="sr-only"
        data-testid="member-guest-find-status"
      >
        {announcement}
      </p>

      {isLoading && (
        <p className="text-xs text-muted-foreground">{MEMBER_GUEST_FIND_COPY.searching}</p>
      )}

      {state.kind === "RATE_LIMITED" && (
        <Alert variant="warning">
          <p>{MEMBER_GUEST_FIND_COPY.rateLimited}</p>
        </Alert>
      )}

      {state.kind === "ERROR" && (
        <Alert variant="warning">
          <p>{MEMBER_GUEST_FIND_COPY.networkError}</p>
        </Alert>
      )}

      {!selected && messageText && (
        <div className="space-y-1.5">
          <div
            data-testid="member-guest-find-message"
            className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            {messageText}
          </div>
          {messageText === MEMBER_GUEST_FIND_COPY.noEmailMatch && (
            <p className="text-xs text-muted-foreground">
              {MEMBER_GUEST_FIND_COPY.noEmailMatchHelp}
            </p>
          )}
        </div>
      )}

      {showCandidateList && (
        <div>
          {listMode === "EMAIL" && (
            <p className="mb-2 text-xs text-muted-foreground">
              {describeHouseholdCandidatePrompt(candidates.length)}
            </p>
          )}
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Matching members"
            aria-busy={isLoading || undefined}
            // Ten rows must not shove the guest form down the page, least of all
            // on a phone (F14) — the house pattern from address-autocomplete.
            className="max-h-60 divide-y overflow-y-auto rounded-md border border-border"
          >
            {candidates.map((candidate, index) => {
              const disabled = alreadyAdded.has(candidate.memberId);
              return (
                <li
                  key={candidate.memberId}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={disabled || undefined}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => chooseCandidate(candidate)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm ${
                      index === activeIndex ? "bg-accent text-accent-foreground" : ""
                    }`}
                  >
                    <span className="font-medium">
                      {candidate.firstName} {candidate.lastName}
                    </span>
                    <span className="rounded-md border border-border px-2 py-0.5 text-xs font-semibold">
                      {ageTierLabel(candidate.ageTier)}
                    </span>
                    {disabled && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {MEMBER_GUEST_FIND_COPY.alreadyAdded}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {showTruncationHint && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {MEMBER_GUEST_FIND_COPY.truncated}
            </p>
          )}
          {/* Two members with the same name and the same age group render as two
              identical rows, because a row is allowed to show nothing else
              (D-19). Rather than invent a distinguisher the booker never had — a
              town, a masked email — we point them at a fact they can go and ask
              for. In the EMAIL mode that cannot be the address: they have just
              typed it (F8). */}
          {hasIndistinguishableMemberGuestCandidates(candidates) && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {listMode === "EMAIL"
                ? MEMBER_GUEST_FIND_COPY.sameNameEmail
                : MEMBER_GUEST_FIND_COPY.sameName}
            </p>
          )}
        </div>
      )}

      {addError && (
        <Alert variant="error">
          {/* Beneath the person it was about, which is where the signed-off
              mockup draws it (panel 13) — the add closes the panel, so the
              candidate is passed back in rather than remembered here (F9). */}
          {refusedCandidate && (
            <p className="font-semibold">
              {refusedCandidate.firstName} {refusedCandidate.lastName}
            </p>
          )}
          <p>{addError}</p>
          <p className="mt-1 text-xs">{MEMBER_GUEST_FIND_COPY.refusalHelp}</p>
        </Alert>
      )}

      {!selected && (
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Adult" / "Child" — sentence case, as the mockup draws the row badges. */
function ageTierLabel(ageTier: string): string {
  return ageTier.charAt(0) + ageTier.slice(1).toLowerCase();
}
