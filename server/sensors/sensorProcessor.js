import { normalizeSensorPayload } from "./validateSensor.js";
import { getAdmin, getFirestore, processSensorOccupancy } from "./sessionEngine.js";

export async function sensorProcessor(payload) {
  const admin = getAdmin();
  const db = getFirestore();

  const { ok, reason, normalized } = normalizeSensorPayload(payload);

  if (!ok) {
    await db.collection("events_log").add({
      sensor_id: payload?.sensor_id ?? payload?.sensorId ?? payload?.element ?? null,
      zone_id: null,
      occupied: null,
      decision: reason,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      raw_payload: payload ?? null,
    });

    return { decision: reason };
  }

  const { sensorId, occupied, ts, raw } = normalized;
  let result;
  try {
    result = await processSensorOccupancy({ sensorId, occupied, ts });
  } catch (err) {
    result = {
      zoneRef: null,
      zoneId: null,
      decision: `processing_error:${err.message}`,
    };
  }

  await db.collection("events_log").add({
    sensor_id: sensorId,
    zone_id: result.zoneRef || null,
    occupied,
    decision: result.decision,
    timestamp: admin.firestore.Timestamp.fromDate(ts),
    raw_payload: raw,
  });

  return {
    sensorId,
    zoneId: result.zoneId,
    occupied,
    decision: result.decision,
  };
}
