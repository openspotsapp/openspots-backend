import { createRequire } from "module";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

function getAdmin() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!raw) {
      throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(raw)),
    });
  }

  return admin;
}

function normalizeData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

async function removeInvalidTokens(tokens) {
  if (!tokens.length) return;

  const db = getAdmin().firestore();

  for (const token of tokens) {
    const userSnap = await db
      .collection("users")
      .where("fcm_tokens", "array-contains", token)
      .get();

    for (const userDoc of userSnap.docs) {
      await userDoc.ref.update({
        fcm_tokens: getAdmin().firestore.FieldValue.arrayRemove(token),
      });
    }
  }
}

export async function sendPushToTokens(tokens, payload) {
  const uniqueTokens = Array.isArray(tokens)
    ? [...new Set(tokens.filter((t) => typeof t === "string" && t.trim().length > 0))]
    : [];

  if (uniqueTokens.length === 0) {
    return { successCount: 0, failureCount: 0, responses: [] };
  }

  const messaging = getAdmin().messaging();
  const title = payload?.notification?.title || "";
  const body = payload?.notification?.body || "";
  const data = normalizeData(payload?.data || {});
  const message = {
    tokens: uniqueTokens,
    notification: {
      title,
      body,
    },
    data,
  };

  const response = await messaging.sendEachForMulticast(message);

  console.log("[FCM] sendEachForMulticast result", {
    successCount: response.successCount,
    failureCount: response.failureCount,
  });

  const invalidTokens = [];

  response.responses.forEach((entry, idx) => {
    if (
      !entry.success &&
      entry.error?.code === "messaging/registration-token-not-registered"
    ) {
      invalidTokens.push(uniqueTokens[idx]);
    }
  });

  await removeInvalidTokens(invalidTokens);

  return response;
}
