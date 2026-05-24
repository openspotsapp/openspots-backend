import { normalizeSensorPayload } from "./validateSensor.js";
import { getAdmin, getFirestore, processSensorOccupancy } from "./sessionEngine.js";

const ACTIVE_PRESENCE_WINDOW_MS = 120 * 1000;
const NEARBY_DISTANCE_FEET = 100;
const FEET_PER_METER = 3.28084;

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

    let pendingSessionResult = null;
    if (payload.vehiclePresence === true) {
      pendingSessionResult = await createPendingSessionForNearbyUser({
        db,
        admin,
        spotDoc: doc,
        spotData: existing,
        payload,
      });
    } else {
      pendingSessionResult = await cancelSensorPendingSessionsForClearedSpot({
        db,
        admin,
        spotDoc: doc,
      });
    }

    console.log("[AMQP] Updated Urbiotica vehicle spot", {
      docId: doc.id,
      oldAvailability: existing.is_available ?? null,
      newAvailability,
      sensorStatus: updatePayload.sensor_status,
      pendingSessionDecision: pendingSessionResult?.decision ?? null,
    });

    return {
      decision: "urbiotica_vehicle_availability_updated",
      spotId: doc.id,
      isAvailable: newAvailability,
      pendingSession: pendingSessionResult,
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

async function createPendingSessionForNearbyUser({ db, admin, spotDoc, spotData, payload }) {
  const candidates = await findNearbyActivePresenceCandidates({ db, spotDoc, spotData, payload });

  console.log("[AMQP] Nearby active FindSpot candidates found", {
    spotId: spotDoc.id,
    count: candidates.length,
    candidates: candidates.map((candidate) => ({
      uid: candidate.uid,
      distanceFeet: Number(candidate.distanceFeet.toFixed(2)),
    })),
  });

  if (candidates.length === 0) {
    console.log("[AMQP] No nearby active FindSpot user for sensor vehicle event", {
      spotId: spotDoc.id,
    });
    return { decision: "no_nearby_active_user" };
  }

  if (candidates.length > 1) {
    console.warn("[AMQP] Ambiguous nearby active FindSpot users for sensor vehicle event", {
      spotId: spotDoc.id,
      candidates: candidates.map((candidate) => ({
        uid: candidate.uid,
        distanceFeet: Number(candidate.distanceFeet.toFixed(2)),
      })),
    });
    return { decision: "ambiguous_nearby_active_users", candidateCount: candidates.length };
  }

  return createPendingSessionIfEligible({
    db,
    admin,
    spotDoc,
    spotData,
    payload,
    candidate: candidates[0],
  });
}

async function cancelSensorPendingSessionsForClearedSpot({ db, admin, spotDoc }) {
  const pendingSessions = await getPendingSessionsForSpot(db, spotDoc.ref);
  const sensorPendingSessions = pendingSessions.filter((session) =>
    session.data.pending_source === "sensor_nearby_user"
  );

  if (sensorPendingSessions.length === 0) {
    console.log("[AMQP] No sensor-created pending sessions to cancel after sensor cleared", {
      spotId: spotDoc.id,
    });
    return { decision: "no_sensor_pending_sessions_to_cancel", cancelledCount: 0 };
  }

  const batch = db.batch();
  const now = admin.firestore.FieldValue.serverTimestamp();

  for (const session of sensorPendingSessions) {
    batch.update(session.doc.ref, {
      status: "CANCELLED",
      cancellation_reason: "sensor_cleared_before_confirmation",
      cancelled_at: now,
      last_updated: now,
    });
  }

  await batch.commit();

  console.log("[AMQP] Pending sessions cancelled because sensor cleared before confirmation", {
    spotId: spotDoc.id,
    sessionIds: sensorPendingSessions.map((session) => session.doc.id),
    reason: "sensor_cleared_before_confirmation",
  });

  return {
    decision: "sensor_pending_sessions_cancelled",
    cancelledCount: sensorPendingSessions.length,
    sessionIds: sensorPendingSessions.map((session) => session.doc.id),
  };
}

async function findNearbyActivePresenceCandidates({ db, spotDoc, spotData, payload }) {
  const spotLocation = extractLatLng(spotData) || extractLatLng(payload);
  if (!spotLocation) {
    console.warn("[AMQP] Cannot match nearby users because spot has no coordinates", {
      spotId: spotDoc.id,
    });
    return [];
  }

  const cutoffMs = Date.now() - ACTIVE_PRESENCE_WINDOW_MS;
  const presenceSnap = await db
    .collectionGroup("presence")
    .where("app_state", "==", "active")
    .limit(250)
    .get();
  const candidates = [];

  for (const presenceDoc of presenceSnap.docs) {
    if (presenceDoc.id !== "current") continue;

    const presence = presenceDoc.data() || {};
    if (presence.foreground_screen !== "FindSpot") continue;

    const seenAtMs = toMillis(presence.last_location_seen_at);
    if (!seenAtMs || seenAtMs < cutoffMs) continue;

    const userLocation = extractLatLng(presence.last_location);
    if (!userLocation) continue;

    const distanceFeet = distanceInFeet(spotLocation, userLocation);
    const uid = presence.uid || presenceDoc.ref.parent.parent?.id || null;

    console.log("[AMQP] Nearby user distance calculated", {
      spotId: spotDoc.id,
      uid,
      distanceFeet: Number(distanceFeet.toFixed(2)),
    });

    if (uid && distanceFeet <= NEARBY_DISTANCE_FEET) {
      candidates.push({
        uid,
        distanceFeet,
        presence,
        presenceRef: presenceDoc.ref,
      });
    }
  }

  return candidates;
}

async function createPendingSessionIfEligible({ db, admin, spotDoc, spotData, payload, candidate }) {
  const userRef = db.collection("users").doc(candidate.uid);
  const now = admin.firestore.FieldValue.serverTimestamp();

  return db.runTransaction(async (tx) => {
    const existingForUser = await getCurrentUserSessions(tx, db, {
      userRef,
      uid: candidate.uid,
    });
    const activeUserSession = existingForUser.find((session) => session.status === "ACTIVE");
    const sameSpotPendingUserSession = existingForUser.find((session) =>
      session.status === "PENDING" && sameSpot(session.data.zone_id, spotDoc.ref)
    );
    const pendingUserSession = existingForUser.find((session) => session.status === "PENDING");

    if (activeUserSession) {
      console.log("[AMQP] Active user session exists; skipping sensor pending creation", {
        uid: candidate.uid,
        sessionId: activeUserSession.doc.id,
        spotId: spotDoc.id,
      });
      return { decision: "user_active_session_exists", sessionId: activeUserSession.doc.id };
    }

    if (sameSpotPendingUserSession) {
      console.log("[AMQP] Existing pending session reused for sensor vehicle event", {
        uid: candidate.uid,
        sessionId: sameSpotPendingUserSession.doc.id,
        spotId: spotDoc.id,
      });
      return { decision: "existing_pending_reused", sessionId: sameSpotPendingUserSession.doc.id };
    }

    if (pendingUserSession) {
      console.log("[AMQP] User already has pending session for another spot; skipping", {
        uid: candidate.uid,
        sessionId: pendingUserSession.doc.id,
        spotId: spotDoc.id,
      });
      return { decision: "user_pending_session_exists", sessionId: pendingUserSession.doc.id };
    }

    const existingForSpot = await getCurrentSpotSessions(tx, db, spotDoc.ref);
    const activeSpotSession = existingForSpot.find((session) => session.status === "ACTIVE");
    const pendingSpotSession = existingForSpot.find((session) => session.status === "PENDING");

    if (activeSpotSession) {
      console.log("[AMQP] Active spot session exists; skipping sensor pending creation", {
        uid: candidate.uid,
        sessionId: activeSpotSession.doc.id,
        spotId: spotDoc.id,
      });
      return { decision: "spot_active_session_exists", sessionId: activeSpotSession.doc.id };
    }

    if (pendingSpotSession) {
      console.log("[AMQP] Existing pending session for spot reused/skipped", {
        uid: candidate.uid,
        sessionId: pendingSpotSession.doc.id,
        spotId: spotDoc.id,
      });
      return { decision: "spot_pending_session_exists", sessionId: pendingSpotSession.doc.id };
    }

    const sessionRef = db.collection("parking_sessions").doc();
    const ratePerHour = numberOrNull(spotData.rate_per_hour);
    const ratePerMinute = numberOrNull(spotData.rate_per_minute) ??
      (ratePerHour !== null ? Number((ratePerHour / 60).toFixed(6)) : null);

    tx.set(sessionRef, withoutUndefined({
      status: "PENDING",
      pending_source: "sensor_nearby_user",
      pending_started_at: now,
      created_at: now,
      user_id: userRef,
      user_uid: candidate.uid,
      zone_id: spotDoc.ref,
      zone_number: spotData.zone_number ?? payload.zoneId,
      location_name: spotData.location_name ?? spotData.name ?? payload.description,
      rate_per_hour: ratePerHour,
      rate_per_minute: ratePerMinute,
      sensor_provider: "urbiotica",
      sensor_id: payload.elementId ?? spotData.urbiotica_element_id,
      urbiotica_element_id: payload.elementId ?? spotData.urbiotica_element_id,
      urbiotica_pom_id: payload.pomId ?? payload.measurementPointId ?? spotData.urbiotica_pom_id,
      sensor_confirmed: true,
      vehicle_detected_at: now,
    }));

    console.log("[AMQP] Pending parking session created from nearby sensor match", {
      uid: candidate.uid,
      sessionId: sessionRef.id,
      spotId: spotDoc.id,
      distanceFeet: Number(candidate.distanceFeet.toFixed(2)),
    });

    return { decision: "pending_session_created", sessionId: sessionRef.id };
  });
}

async function getCurrentUserSessions(tx, db, { userRef, uid }) {
  const docs = new Map();
  const userRefSnap = await tx.get(
    db
      .collection("parking_sessions")
      .where("user_id", "==", userRef)
      .limit(30)
  );
  const userUidSnap = await tx.get(
    db
      .collection("parking_sessions")
      .where("user_uid", "==", uid)
      .limit(30)
  );
  const userIdStringSnap = await tx.get(
    db
      .collection("parking_sessions")
      .where("user_id", "==", uid)
      .limit(30)
  );

  for (const doc of [...userRefSnap.docs, ...userUidSnap.docs, ...userIdStringSnap.docs]) {
    if (isPendingOrActive(doc.data()?.status)) {
      docs.set(doc.id, doc);
    }
  }

  return sortCurrentSessions(Array.from(docs.values()));
}

async function getCurrentSpotSessions(tx, db, spotRef) {
  const docs = new Map();
  const spotRefSnap = await tx.get(
    db
      .collection("parking_sessions")
      .where("zone_id", "==", spotRef)
      .limit(30)
  );
  const spotPathSnap = await tx.get(
    db
      .collection("parking_sessions")
      .where("zone_id", "==", spotRef.path)
      .limit(30)
  );

  for (const doc of [...spotRefSnap.docs, ...spotPathSnap.docs]) {
    if (isPendingOrActive(doc.data()?.status)) {
      docs.set(doc.id, doc);
    }
  }

  return sortCurrentSessions(Array.from(docs.values()));
}

async function getPendingSessionsForSpot(db, spotRef) {
  const docs = new Map();
  const spotRefSnap = await db
    .collection("parking_sessions")
    .where("zone_id", "==", spotRef)
    .limit(30)
    .get();
  const spotPathSnap = await db
    .collection("parking_sessions")
    .where("zone_id", "==", spotRef.path)
    .limit(30)
    .get();

  for (const doc of [...spotRefSnap.docs, ...spotPathSnap.docs]) {
    if (doc.data()?.status === "PENDING") {
      docs.set(doc.id, { doc, data: doc.data() || {} });
    }
  }

  return Array.from(docs.values());
}

function sortCurrentSessions(docs) {
  return docs
    .map((doc) => ({ doc, data: doc.data() || {} }))
    .sort((a, b) => {
      if (a.data.status === "ACTIVE" && b.data.status !== "ACTIVE") return -1;
      if (b.data.status === "ACTIVE" && a.data.status !== "ACTIVE") return 1;
      return timestampMillis(b.data.created_at ?? b.data.pending_started_at) -
        timestampMillis(a.data.created_at ?? a.data.pending_started_at);
    })
    .map((session) => ({
      doc: session.doc,
      data: session.data,
      status: session.data.status,
    }));
}

function sameSpot(zoneValue, spotRef) {
  if (!zoneValue || !spotRef) return false;
  if (typeof zoneValue === "string") return zoneValue === spotRef.path;
  return zoneValue.path === spotRef.path;
}

function isPendingOrActive(status) {
  return status === "PENDING" || status === "ACTIVE";
}

function extractLatLng(value) {
  if (!value) return null;

  if (typeof value.latitude === "number" && typeof value.longitude === "number") {
    return { latitude: value.latitude, longitude: value.longitude };
  }

  if (typeof value.lat === "number" && typeof value.lng === "number") {
    return { latitude: value.lat, longitude: value.lng };
  }

  if (typeof value.latitude === "string" && typeof value.longitude === "string") {
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  }

  if (typeof value.lat === "string" && typeof value.lng === "string") {
    const latitude = Number(value.lat);
    const longitude = Number(value.lng);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return { latitude, longitude };
    }
  }

  return extractLatLng(value.location) ||
    extractLatLng(value.geo) ||
    extractLatLng(value.geopoint) ||
    extractLatLng(value.coordinates) ||
    null;
}

function distanceInFeet(a, b) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const haversine = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * earthRadiusMeters * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return meters * FEET_PER_METER;
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function timestampMillis(value) {
  return toMillis(value) ?? 0;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
