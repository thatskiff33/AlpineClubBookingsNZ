import { clubConfig } from "@/config/club";

export const LODGE_CAPACITY = clubConfig.beds.reduce(
  (total, bed) => total + bed.capacity,
  0,
);
