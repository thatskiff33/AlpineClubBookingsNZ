import { describe, expect, it } from "vitest";
import {
  otherLodgeChoiceLabel,
  otherLodgeNameWithLocation,
  withOtherLodgeChoiceLabels,
} from "@/lib/other-lodge-choice-label";
import { ownedOtherLodgeEditLabel } from "@/lib/other-lodges";

describe("Other lodge choice labels (#69: two lodges may share a name)", () => {
  const choices = [
    { id: "a", name: "Ruapehu Lodge", location: "Whakapapa" },
    { id: "b", name: "Ruapehu Lodge", location: " Turoa " },
    { id: "c", name: "Tasman Lodge", location: "Mt Cook" },
  ];

  it("adds the location only where another choice shares the name", () => {
    expect(withOtherLodgeChoiceLabels(choices)).toEqual([
      { id: "a", name: "Ruapehu Lodge", label: "Ruapehu Lodge (Whakapapa)" },
      { id: "b", name: "Ruapehu Lodge", label: "Ruapehu Lodge (Turoa)" },
      { id: "c", name: "Tasman Lodge", label: "Tasman Lodge" },
    ]);
  });

  it("keeps the bare name when a shared-name lodge has no location to add", () => {
    expect(otherLodgeChoiceLabel({ name: "Ruapehu Lodge", location: null }, choices)).toBe("Ruapehu Lodge");
    expect(otherLodgeChoiceLabel({ name: "Ruapehu Lodge", location: "  " }, choices)).toBe("Ruapehu Lodge");
  });

  it("never sends the location on: only id, name and label leave", () => {
    for (const choice of withOtherLodgeChoiceLabels(choices)) {
      expect(Object.keys(choice).sort()).toEqual(["id", "label", "name"]);
    }
  });

  it("treats names that only LOOK alike as shared (case, spacing, invisible characters)", () => {
    const lookalikes = [
      { name: "Ruapehu Lodge", location: "Whakapapa" },
      { name: "ruapehu​ lodge", location: "Turoa" },
    ];
    expect(otherLodgeChoiceLabel(lookalikes[0], lookalikes)).toBe("Ruapehu Lodge (Whakapapa)");
    expect(otherLodgeChoiceLabel(lookalikes[1], lookalikes)).toBe("ruapehu​ lodge (Turoa)");
  });

  it("names one lodge with its location for a view that shows it alone", () => {
    expect(otherLodgeNameWithLocation({ name: "Ruapehu Lodge", location: " Whakapapa " })).toBe("Ruapehu Lodge (Whakapapa)");
    expect(otherLodgeNameWithLocation({ name: "Ruapehu Lodge", location: null })).toBe("Ruapehu Lodge");
    expect(otherLodgeNameWithLocation({ name: "Ruapehu Lodge" })).toBe("Ruapehu Lodge");
  });

  it("tells two owned lodges' Edit buttons apart by location", () => {
    const owned = [
      { name: "Ruapehu Lodge", location: "Whakapapa" },
      { name: "Ruapehu Lodge", location: "Turoa" },
    ];
    expect(ownedOtherLodgeEditLabel(owned, owned[1])).toBe("Edit Ruapehu Lodge (Turoa)");
    expect(ownedOtherLodgeEditLabel([owned[0]], owned[0])).toBe("Edit my Lodge");
  });
});
