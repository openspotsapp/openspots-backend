export function normalizeSensorPayload(payload) {
  const raw = payload || {};

  const sensorIdRaw = raw.sensor_id ?? raw.sensorId ?? raw.element;
  const sensorId = typeof sensorIdRaw === "string" ? sensorIdRaw.trim() : String(sensorIdRaw || "").trim();

  const occupied = normalizeOccupied(raw.occupied ?? raw.value ?? raw.status);
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
      occupied,
      ts,
      raw,
    },
  };
}

function normalizeOccupied(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "occupied", "busy", "on"].includes(lowered)) return true;
    if (["0", "false", "free", "available", "off"].includes(lowered)) return false;
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
