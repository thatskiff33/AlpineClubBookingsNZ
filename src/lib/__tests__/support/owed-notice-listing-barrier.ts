import type { OwedNoticeSource } from "@/lib/owed-notice/deliver";

/**
 * #5433 review: a source for proving two drains really overlap. Each drain's
 * read of a kind's markers is held, after it has read them, until `drains`
 * drains have read that kind, so every drain lists the same markers before
 * any of them claims one. A test can then assert each run's `checked` count:
 * drains that ran one after the other would show the later run checking none.
 */
export function listingTogether(source: OwedNoticeSource, drains = 2): OwedNoticeSource {
  const gates = new Map<string, { arrived: number; open: () => void; opened: Promise<void> }>();
  return {
    name: `${source.name} (drains list together)`,
    async listDue(deliverer, at) {
      const refs = await source.listDue(deliverer, at);
      let gate = gates.get(deliverer.kind);
      if (!gate) {
        let open = () => {};
        const opened = new Promise<void>((resolve) => (open = resolve));
        gate = { arrived: 0, open, opened };
        gates.set(deliverer.kind, gate);
      }
      gate.arrived += 1;
      if (gate.arrived >= drains) gate.open();
      await gate.opened;
      return refs;
    },
  };
}
