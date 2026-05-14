import { normalizeSensorPayload } from "./validateSensor.js";
import { getAdmin, getFirestore, processSensorOccupancy } from "./sessionEngine.js";

export async function sensorProcessor(payload) {
  const provider = payload?.sensorProvider ?? payload?.sensor_provider;
  if (provider === "urbiotica") {
    return processUrbioticaSensorEvent(payload);
  }

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

  const { sensorId, occupied, ts, raw, ...identifiers } = normalized;
  let result;
  try {
    result = await processSensorOccupancy({ sensorId, occupied, ts, identifiers });
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

async function processUrbioticaSensorEvent(payload) {
  const admin = getAdmin();
  const db = getFirestore();
  const phenomenon = payload?.phenomenon ?? payload?.phenomenonId ?? payload?.phenomenonid;

  if (phenomenon !== "vehicle" && phenomenon !== "node_battery") {
    return { decision: "ignored_urbiotica_phenomenon", phenomenon };
  }

  const match = await findUrbioticaSpot(db, payload);

  if (!match) {
    console.warn("[AMQP] No matching Urbiotica private_metered_parking document found", {
      elementId: payload?.elementId,
      pomId: payload?.pomId,
      measurementPointId: payload?.measurementPointId,
      zoneId: payload?.zoneId,
      phenomenon,
    });
    return { decision: "urbiotica_spot_not_found", phenomenon };
  }

  const { doc, matchedField, matchedValue } = match;
  const existing = doc.data() || {};
  const updatePayload = {
    last_updated: admin.firestore.FieldValue.serverTimestamp(),
    last_sensor_event_at: admin.firestore.FieldValue.serverTimestamp(),
    last_sensor_payload: summarizeUrbioticaPayload(payload),
    last_sensor_provider: "urbiotica",
  };

  console.log("[AMQP] Matching Urbiotica spot found", {
    docId: doc.id,
    matchedField,
    matchedValue,
    phenomenon,
  });

  if (phenomenon === "vehicle") {
    if (typeof payload.vehiclePresence !== "boolean") {
      console.warn("[AMQP] Urbiotica vehicle event missing boolean vehiclePresence", {
        docId: doc.id,
        vehiclePresence: payload.vehiclePresence,
      });
      return { decision: "invalid_urbiotica_vehicle_presence", spotId: doc.id };
    }

    const newAvailability = !payload.vehiclePresence;
    updatePayload.is_available = newAvailability;
    updatePayload.sensor_status = payload.vehiclePresence ? "occupied" : "available";

    await doc.ref.update(updatePayload);

    console.log("[AMQP] Updated Urbiotica vehicle spot", {
      docId: doc.id,
      oldAvailability: existing.is_available ?? null,
      newAvailability,
      sensorStatus: updatePayload.sensor_status,
    });

    return {
      decision: "urbiotica_vehicle_availability_updated",
      spotId: doc.id,
      isAvailable: newAvailability,
    };
  }

  if (typeof payload.batteryVoltage !== "number") {
    console.warn("[AMQP] Urbiotica battery event missing numeric batteryVoltage", {
      docId: doc.id,
      batteryVoltage: payload.batteryVoltage,
    });
    return { decision: "invalid_urbiotica_battery_voltage", spotId: doc.id };
  }

  updatePayload.battery_voltage = payload.batteryVoltage;
  updatePayload.last_battery_event_at = admin.firestore.FieldValue.serverTimestamp();

  await doc.ref.update(updatePayload);

  console.log("[AMQP] Updated Urbiotica battery spot", {
    docId: doc.id,
    batteryVoltage: payload.batteryVoltage ?? null,
  });

  return {
    decision: "urbiotica_battery_updated",
    spotId: doc.id,
    batteryVoltage: payload.batteryVoltage ?? null,
  };
}

async function findUrbioticaSpot(db, payload) {
  const collection = db.collection("private_metered_parking");
  const matches = [
    ["urbiotica_element_id", payload?.elementId],
    ["urbiotica_pom_id", payload?.pomId],
    ["urbiotica_pom_id", payload?.measurementPointId],
  ];

  for (const [field, identifier] of matches) {
    for (const value of queryValues(identifier)) {
      const snap = await collection
        .where("sensor_provider", "==", "urbiotica")
        .where(field, "==", value)
        .limit(1)
        .get();

      if (!snap.empty) {
        return {
          doc: snap.docs[0],
          matchedField: field,
          matchedValue: value,
        };
      }
    }
  }

  return null;
}

function queryValues(value) {
  if (value === undefined || value === null || value === "") return [];

  const values = [value];
  const numericValue = Number(value);
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(numericValue)) {
    values.push(numericValue);
  }

  return values;
}

function summarizeUrbioticaPayload(payload) {
  return withoutUndefined({
    phenomenon: payload?.phenomenon ?? payload?.phenomenonId ?? payload?.phenomenonid,
    elementId: payload?.elementId,
    pomId: payload?.pomId,
    measurementPointId: payload?.measurementPointId,
    zoneId: payload?.zoneId,
    description: payload?.description,
    latitude: payload?.latitude,
    longitude: payload?.longitude,
    vehiclePresence: payload?.vehiclePresence,
    batteryVoltage: payload?.batteryVoltage,
    measures: Array.isArray(payload?.measures) ? payload.measures.slice(0, 3) : undefined,
  });
}

function withoutUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}
