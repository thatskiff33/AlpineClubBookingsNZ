import { findCustodianOccupancies, type CustodianOccupancy } from "./custodian-occupancy";
import { isMinorAgeTier } from "./display-name-granularity";
import { prisma } from "./prisma";

/** A custodian occupancy with who it is, for a surface that names custodians. */
export interface CustodianOccupant extends CustodianOccupancy {
  memberFirstName: string;
  memberLastName: string;
  memberIsMinor: boolean;
}

/**
 * The capacity count's own custodian occupancies ({@link findCustodianOccupancies}:
 * a held bed or the "Custodian (lives on site)" tick, one row per assignment)
 * with names and the minor flag, for the member lodge roster (#3818). It calls
 * the count's loader rather than restating its filter, so the roster lists
 * exactly the custodians who take a space, and a ticked bed holder once. The
 * names are a second read so the capacity hot path never reads one.
 */
export async function findCustodianOccupants(input: {
  lodgeId: string;
  from: Date;
  toExclusive: Date;
}): Promise<CustodianOccupant[]> {
  const occupancies = await findCustodianOccupancies(input);
  if (occupancies.length === 0) return [];
  const members = await prisma.member.findMany({
    where: { id: { in: [...new Set(occupancies.map((o) => o.memberId))] } },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
  });
  const byId = new Map(members.map((member) => [member.id, member]));
  return occupancies.map((occupancy) => {
    const member = byId.get(occupancy.memberId);
    return {
      ...occupancy,
      memberFirstName: member?.firstName ?? "",
      memberLastName: member?.lastName ?? "",
      // A member the read did not return is never named: fail closed.
      memberIsMinor: member ? isMinorAgeTier(member.ageTier) : true,
    };
  });
}
