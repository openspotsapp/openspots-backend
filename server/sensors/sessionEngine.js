import { createRequire } from "module";
import {
  notifySessionCompleted,
  notifySessionStarted,
} from "../notifications/notificationEngine.js";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

function getDb() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
    });
  }

  return admin.firestore();
}

export async function resolveZoneBySensorId(sensorId) {
  const db = getDb();
  const zoneDoc = await resolvePrivateMeteredParkingDoc(db, { sensorId });

  if (!zoneDoc) {
    return null;
  }

  return zoneDoc;
}

async function getFirstMatchingDoc(tx, query) {
  const snap = await tx.get(query.limit(1));
  return snap.empty ? null : snap.docs[0];
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

async function resolvePrivateMeteredParkingDoc(db, identifiers, tx = null) {
  const collection = db.collection("private_metered_parking");
  const matches = [
    ["urbiotica_pom_id", identifiers.pomId],
    ["urbiotica_element_id", identifiers.elementId],
    ["sensor_id", identifiers.sensorId],
    ["zone_number", identifiers.zoneNumber],
    ["spot_number", identifiers.spotNumber],
  ];

  for (const [field, identifier] of matches) {
    for (const value of queryValues(identifier)) {
      const query = collection.where(field, "==", value);
      const doc = tx ? await getFirstMatchingDoc(tx, query) : (await query.limit(1).get()).docs[0] ?? null;
      if (doc) {
        return doc;
      }
    }
  }

  return null;
}

export async function processSensorOccupancy({ sensorId, occupied, ts, identifiers = {} }) {
  const db = getDb();
  const eventTime = admin.firestore.Timestamp.fromDate(ts);
  const result = await db.runTransaction(async (tx) => {
    const zoneDoc = await resolvePrivateMeteredParkingDoc(
      db,
      { ...identifiers, sensorId },
      tx
    );

    if (!zoneDoc) {
      console.log("[AMQP] No matching private_metered_parking document found");
      return {
        zoneRef: null,
        zoneId: null,
        decision: "zone_not_found",
      };
    }

    const zoneRef = zoneDoc.ref;
    const activeQuery = db
      .collection("parking_sessions")
      .where("status", "==", "ACTIVE")
      .where("zone_id", "==", zoneRef)
      .limit(1);
    const activeSnap = await tx.get(activeQuery);

    if (occupied === true) {
      tx.update(zoneRef, {
        is_available: false,
        sensor_status: "occupied",
        last_sensor_seen_at: admin.firestore.FieldValue.serverTimestamp(),
        last_updated: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("[AMQP] Sensor occupied -> Firestore updated");

      if (!activeSnap.empty) {
        return {
          zoneRef,
          zoneId: zoneRef.path,
          decision: "already_active",
        };
      }

      const newSessionRef = db.collection("parking_sessions").doc();
      tx.set(newSessionRef, {
        sensor_id: sensorId,
        zone_id: zoneRef,
        arrival_time: eventTime,
        status: "ACTIVE",
        endingSoonNotified: false,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        zoneRef,
        zoneId: zoneRef.path,
        sessionId: newSessionRef.id,
        userId: null,
        decision: "session_started",
      };
    }

    tx.update(zoneRef, {
      is_available: true,
      sensor_status: "available",
      last_sensor_seen_at: admin.firestore.FieldValue.serverTimestamp(),
      last_updated: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("[AMQP] Sensor available -> Firestore updated");

    if (activeSnap.empty) {
      return {
        zoneRef,
        zoneId: zoneRef.path,
        decision: "no_active_session",
      };
    }

    const sessionDoc = activeSnap.docs[0];
    const sessionData = sessionDoc.data() || {};
    const arrivalAt = sessionData.arrival_time?.toDate?.();
    const totalMinutes = arrivalAt
      ? Math.max(0, Math.floor((ts.getTime() - arrivalAt.getTime()) / 60000))
      : 0;
    const ratePerMinute =
      typeof sessionData.rate_per_minute === "number"
        ? sessionData.rate_per_minute
        : 0;
    const priceCharged = Number((totalMinutes * ratePerMinute).toFixed(2));

    tx.update(sessionDoc.ref, {
      departure_time: eventTime,
      total_minutes: totalMinutes,
      price_charged: priceCharged,
      status: "COMPLETED",
      last_updated: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      zoneRef,
      zoneId: zoneRef.path,
      sessionId: sessionDoc.id,
      userId:
        sessionData.user_id?.id ||
        (typeof sessionData.user_id === "string" ? sessionData.user_id : null),
      totalMinutes,
      priceCharged,
      decision: "session_completed",
    };
  });

  if (result.decision === "session_started" && result.userId) {
    try {
      await notifySessionStarted(result.userId, result.zoneId, result.sessionId);
      console.log("Push: session_started", result.sessionId);
    } catch (err) {
      console.error("Push failed (session_started):", err);
    }
  }

  if (result.decision === "session_completed" && result.userId) {
    try {
      await notifySessionCompleted(
        result.userId,
        result.zoneId,
        result.sessionId,
        result.totalMinutes,
        result.priceCharged
      );
      console.log("Push: session_completed", result.sessionId);
    } catch (err) {
      console.error("Push failed (session_completed):", err);
    }
  }

  return result;
}

export function getAdmin() {
  return admin;
}

export function getFirestore() {
  return getDb();
}
