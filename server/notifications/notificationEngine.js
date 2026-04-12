import { createRequire } from "module";
import { sendPushToTokens } from "./sendPush.js";

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

async function getUserNotificationContext(userId) {
  if (!userId || typeof userId !== "string") {
    return { canNotify: false, tokens: [] };
  }

  const db = getDb();
  const userSnap = await db.collection("users").doc(userId).get();

  if (!userSnap.exists) {
    return { canNotify: false, tokens: [] };
  }

  const user = userSnap.data() || {};
  const tokens = Array.isArray(user.fcm_tokens) ? user.fcm_tokens : [];
  const canNotify = user.notifications_enabled !== false;

  return { canNotify, tokens };
}

export async function notifyReservationConfirmed(userId, reservationId) {
  const { canNotify, tokens } = await getUserNotificationContext(userId);
  if (!canNotify || tokens.length === 0) return null;

  return sendPushToTokens(tokens, {
    notification: {
      title: "Reservation Confirmed",
      body: "Your parking spot is secured.",
    },
    data: {
      type: "reservation_confirmed",
      reservationId,
    },
  });
}

export async function notifySessionStarted(userId, zoneId, sessionId) {
  const { canNotify, tokens } = await getUserNotificationContext(userId);
  if (!canNotify || tokens.length === 0) return null;

  return sendPushToTokens(tokens, {
    notification: {
      title: "Parking Session Started",
      body: "Your session has begun.",
    },
    data: {
      type: "session_started",
      zoneId,
      sessionId,
    },
  });
}

export async function notifySessionCompleted(
  userId,
  zoneId,
  sessionId,
  totalMinutes,
  priceCharged
) {
  const { canNotify, tokens } = await getUserNotificationContext(userId);
  if (!canNotify || tokens.length === 0) return null;

  const mins = Number.isFinite(Number(totalMinutes)) ? Number(totalMinutes) : 0;
  const charged = Number.isFinite(Number(priceCharged))
    ? Number(priceCharged).toFixed(2)
    : "0.00";

  return sendPushToTokens(tokens, {
    notification: {
      title: "Session Complete",
      body: `Total time: ${mins} mins. Charged: $${charged}.`,
    },
    data: {
      type: "session_completed",
      zoneId,
      sessionId,
    },
  });
}

export async function notifySessionEndingSoon(userId, zoneId, sessionId) {
  const { canNotify, tokens } = await getUserNotificationContext(userId);
  if (!canNotify || tokens.length === 0) return null;

  return sendPushToTokens(tokens, {
    notification: {
      title: "Parking Ending Soon",
      body: "Your parking session is about to end",
    },
    data: {
      type: "session_ending_soon",
      zoneId,
      sessionId,
    },
  });
}
