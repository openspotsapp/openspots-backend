export function normalizeSensorPayload(payload) {
  const raw = payload || {};

  const pomId = normalizeId(raw.pomId ?? raw.pom_id ?? raw.pom?.id ?? raw.device?.pomId);
  const elementId = normalizeId(raw.elementId ?? raw.element_id ?? raw.element?.id ?? raw.element);
  const measurementPointId = normalizeId(
    raw.measurementPointId ?? raw.measurement_point_id ?? raw.measurementPoint?.id
  );
  const locationId = normalizeId(raw.locationId ?? raw.location_id ?? raw.location?.id);
  const zoneNumber = normalizeId(raw.zone_number ?? raw.zoneNumber);
  const spotNumber = normalizeId(raw.spot_number ?? raw.spotNumber);
  const sensorIdRaw = raw.sensor_id ?? raw.sensorId ?? zoneNumber ?? spotNumber ?? elementId ?? pomId ?? measurementPointId;
  const sensorId = typeof sensorIdRaw === "string" ? sensorIdRaw.trim() : String(sensorIdRaw || "").trim();

  const occupied = normalizeOccupied(raw.vehiclePresence ?? raw.vehicle_presence ?? raw.occupied ?? raw.value ?? raw.status);
  const ts = normalizeTimestamp(raw.ts ?? raw.timestamp ?? raw.time);

  if (!sensorId) {
    return { ok: false, reason: "missing_sensor_id", normalized: null };
  }

  if (typeof occupied !== "boolean") {
    return { ok: false, reason: "invalid_occupied", normalized: null };
  }

  return {
    ok: true,
    reason: null,
    normalized: {
      sensorId,
      pomId,
      elementId,
      measurementPointId,
      locationId,
      zoneNumber,
      spotNumber,
      occupied,
      ts,
      raw,
    },
  };
}

function normalizeId(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeOccupied(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "occupied", "busy", "on", "presence", "present"].includes(lowered)) return true;
    if (["0", "false", "free", "available", "vacant", "empty", "off", "absence", "absent"].includes(lowered)) return false;
  }

  return undefined;
}

function normalizeTimestamp(value) {
  if (!value) return new Date();

  if (value instanceof Date) return value;

  if (typeof value === "number") {
    return new Date(value);
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return new Date();
}
