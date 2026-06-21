export interface WhakapapaRoadStatus {
  name: string;
  status: string;
  wheelRequirements: string;
  roadContent: string;
}

export interface WhakapapaChairlift {
  name: string;
  status: string;
}

export interface WhakapapaCondition {
  name: string;
  temperature: string;
  wind: string;
  snowBase: string;
  snowfall24h: string;
  snowfall7d: string;
}

export interface WhakapapaCurlData {
  updated: string;
  roadStatus: WhakapapaRoadStatus;
  chairlifts: WhakapapaChairlift[];
  conditions: WhakapapaCondition[];
}

export function emptyWhakapapaCurlData(): WhakapapaCurlData {
  return {
    updated: "",
    roadStatus: {
      name: "",
      status: "",
      wheelRequirements: "",
      roadContent: "",
    },
    chairlifts: [],
    conditions: [],
  };
}

export function coerceWhakapapaCurlData(
  payload: unknown,
): WhakapapaCurlData | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Partial<WhakapapaCurlData> & {
    roadStatus?: Partial<WhakapapaRoadStatus>;
  };

  if (!data.roadStatus || typeof data.roadStatus !== "object") {
    return null;
  }

  const chairlifts = Array.isArray(data.chairlifts)
    ? data.chairlifts
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const entry = item as Partial<WhakapapaChairlift>;
          return {
            name: typeof entry.name === "string" ? entry.name : "",
            status: typeof entry.status === "string" ? entry.status : "",
          };
        })
        .filter((item): item is WhakapapaChairlift => item !== null)
    : [];

  const conditions = Array.isArray(data.conditions)
    ? data.conditions
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const entry = item as Partial<WhakapapaCondition>;
          return {
            name: typeof entry.name === "string" ? entry.name : "",
            temperature:
              typeof entry.temperature === "string" ? entry.temperature : "",
            wind: typeof entry.wind === "string" ? entry.wind : "",
            snowBase: typeof entry.snowBase === "string" ? entry.snowBase : "",
            snowfall24h:
              typeof entry.snowfall24h === "string" ? entry.snowfall24h : "",
            snowfall7d:
              typeof entry.snowfall7d === "string" ? entry.snowfall7d : "",
          };
        })
        .filter((item): item is WhakapapaCondition => item !== null)
    : [];

  return {
    updated: typeof data.updated === "string" ? data.updated : "",
    roadStatus: {
      name:
        typeof data.roadStatus.name === "string" ? data.roadStatus.name : "",
      status:
        typeof data.roadStatus.status === "string"
          ? data.roadStatus.status
          : "",
      wheelRequirements:
        typeof data.roadStatus.wheelRequirements === "string"
          ? data.roadStatus.wheelRequirements
          : "",
      roadContent:
        typeof data.roadStatus.roadContent === "string"
          ? data.roadStatus.roadContent
          : "",
    },
    chairlifts,
    conditions,
  };
}
