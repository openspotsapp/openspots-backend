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
  const zoneSnap = await db
    .collection("private_metered_parking")
    .where("sensor_id", "==", sensorId)
    .limit(1)
    .get();

  if (zoneSnap.empty) {
    return null;
  }

  return zoneSnap.docs[0];
}

export async function processSensorOccupancy({ sensorId, occupied, ts }) {
  const db = getDb();
  const eventTime = admin.firestore.Timestamp.fromDate(ts);
  const result = await db.runTransaction(async (tx) => {
    const zoneQuery = db
      .collection("private_metered_parking")
      .where("sensor_id", "==", sensorId)
      .limit(1);
    const zoneSnap = await tx.get(zoneQuery);

    if (zoneSnap.empty) {
      return {
        zoneRef: null,
        zoneId: null,
        decision: "zone_not_found",
      };
    }

    const zoneDoc = zoneSnap.docs[0];
    const zoneRef = zoneDoc.ref;
    const activeQuery = db
      .collection("parking_sessions")
      .where("status", "==", "ACTIVE")
      .where("zone_id", "==", zoneRef)
      .limit(1);
    const activeSnap = await tx.get(activeQuery);

    if (occupied === true) {
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

      tx.update(zoneRef, {
        is_available: false,
        last_updated: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        zoneRef,
        zoneId: zoneRef.path,
        sessionId: newSessionRef.id,
        userId: null,
        decision: "session_started",
      };
    }

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

    tx.update(zoneRef, {
      is_available: true,
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
