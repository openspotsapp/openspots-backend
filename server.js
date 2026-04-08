import "dotenv/config";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { getSpotStatus } from "./backend/spotStatus.js";
import { amqpEvents, liveSpotCache } from "./backend/amqpClient.js";
import { sendEmail, buildWelcomeEmail, buildPaymentMethodAddedEmail, buildReservationConfirmationEmail, buildParkingStartedEmail, buildParkingReceiptEmail, buildParkingCancelledEmail } from "./backend/email.js";
import Stripe from "stripe";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({
  origin: [
    "http://127.0.0.1:5501",
    "http://localhost:5501",
    process.env.BASE_URL
  ],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
const PORT = process.env.PORT || 5500;
const SOCIALS = [
  { href: "mailto:support@openspots.app", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/bn5b41rovg31/badge_email.png", alt: "Email" },
  { href: "https://facebook.com/OpenSpotsApp", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/yp5p4pvic5zc/badge_facebok.png", alt: "Facebook" },
  { href: "https://instagram.com/openspotsapp", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/rtu0rbbejb8p/badge_instagram.png", alt: "Instagram" },
  { href: "https://twitter.com/openspotsapp", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/d6ltpc9lh02v/badge_X.png", alt: "X" },
  { href: "https://tiktok.com/@openspots", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/8ivm5hp3yq17/badge_tiktok.png", alt: "TikTok" },
  { href: "https://youtube.com/@openspotsapp", img: "https://storage.googleapis.com/flutterflow-io-6f20.appspot.com/projects/open-spots-app-977ima/assets/m1160f9479nf/badge_youtube.png", alt: "YouTube" },
];
const resolveUserFirstName = (user) =>
  user?.first_name ||
  user?.firstName ||
  user?.display_name ||
  user?.displayName ||
  "";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const logError = (message, error, context = {}) => {
  console.error({
    level: "error",
    message,
    context,
    error: {
      message: error?.message || "Unknown error",
      type: error?.type || null,
      code: error?.code || null,
      stack: error?.stack || null,
    },
    timestamp: new Date().toISOString(),
  });
};
const buildPaymentIntentIdempotencyKey = ({
  uid,
  amount,
  currency = "usd",
  spotId = "",
  eventId = "",
}) => {
  const seed = [
    uid || "",
    spotId || "",
    eventId || "",
    String(amount ?? ""),
    String(currency).toLowerCase(),
  ].join("|");
  return `pi_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 40)}`;
};
const resolveIdentityFromRequest = async (req) => {
  const body = req.body || {};
  let uid = body.uid || body.userId || null;
  let email = body.email || null;

  if (uid && email) {
    return { uid, email };
  }

  const authHeader = req.headers?.authorization || req.headers?.Authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token) {
      try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        uid = uid || decodedToken?.uid || null;
        email = email || decodedToken?.email || null;
      } catch (err) {
        logError("Failed to verify Firebase ID token", err, { route: req.path });
      }
    }
  }

  return { uid, email };
};
const resolveCheckoutSessionUrl = async (session) => {
  if (session?.url) {
    return session.url;
  }

  const retrievedSession = await stripe.checkout.sessions.retrieve(session.id);
  return retrievedSession?.url || null;
};
const getOrCreateStripeCustomerId = async ({ uid, email }) => {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();
  const userData = userSnap.exists ? userSnap.data() : null;
  const existingCustomerId = userData?.stripeCustomerId || null;
  const existingSnakeCaseCustomerId = userData?.stripe_customer_id || null;

  if (existingCustomerId) return existingCustomerId;
  if (existingSnakeCaseCustomerId) {
    await userRef.set(
      {
        stripeCustomerId: existingSnakeCaseCustomerId,
      },
      { merge: true }
    );
    return existingSnakeCaseCustomerId;
  }

  const customer = await stripe.customers.create({
    email,
    metadata: { uid },
  });

  await userRef.set(
    {
      stripeCustomerId: customer.id,
    },
    { merge: true }
  );

  return customer.id;
};
const ACTIVE_SESSION_INTERVAL = 60 * 1000; // 1 min
const PENDING_SESSION_INTERVAL = 1000; // 1 sec
const CONFIRM_WINDOW_MS = 30_000;

setInterval(async () => {
  try {
    const now = admin.firestore.Timestamp.now();

    const activeSessions = await db
      .collection("parking_sessions")
      .where("status", "==", "ACTIVE")
      .get();

    for (const docSnap of activeSessions.docs) {
      const data = docSnap.data();
      if (!data.arrival_time || typeof data.rate_per_minute !== "number") {
        continue;
      }

      const start = data.arrival_time.toDate();
      const minutes = Math.floor((Date.now() - start.getTime()) / 60000);
      const price = Number((minutes * data.rate_per_minute).toFixed(2));

      await docSnap.ref.update({
        total_minutes: minutes,
        price_charged: price,
        last_updated: now
      });
    }
  } catch (err) {
    console.error("Failed to update active sessions:", err);
  }
}, ACTIVE_SESSION_INTERVAL);

setInterval(async () => {
  try {
    const now = admin.firestore.Timestamp.now();

    const pendingSessions = await db
      .collection("parking_sessions")
      .where("status", "==", "PENDING")
      .get();

    for (const docSnap of pendingSessions.docs) {
      const data = docSnap.data();

      if (!data.pending_started_at) {
        await docSnap.ref.update({
          pending_started_at: admin.firestore.FieldValue.serverTimestamp()
        });
        continue;
      }

      const startedAt = data.pending_started_at.toDate();
      const elapsedMs = now.toMillis() - startedAt.getTime();
      // Protection window to allow confirm to complete
      if (elapsedMs < CONFIRM_WINDOW_MS + 2000) {
        console.log("⏳ Skipping pending session during protection window:", docSnap.id);
        continue;
      }

      if (!data.zone_id) continue;

      const zoneRef =
        typeof data.zone_id === "string" ? db.doc(data.zone_id) : data.zone_id;
      const zoneSnap = await zoneRef.get();
      if (!zoneSnap.exists) continue;

      const zoneData = zoneSnap.data();

      const occupied =
        zoneData.is_available === false || zoneData.is_available === "false";

      if (occupied) {
        await docSnap.ref.update({
          status: "ACTIVE",
          activated_at: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Do not hard-delete pending sessions here. Deletions cause confirm-session 404 races.
        // Keep the document and mark it as expired so clients/backend can still reason about it.
        await docSnap.ref.update({
          status: "EXPIRED",
          expired_at: admin.firestore.FieldValue.serverTimestamp()
        });
        console.warn("⌛ Marked pending session as EXPIRED:", docSnap.id);
      }
    }
  } catch (err) {
    console.error("Failed to process pending sessions:", err);
  }
}, PENDING_SESSION_INTERVAL);

// Serve PUBLIC folder
app.use(express.static(path.join(__dirname, "public")));

app.get("/auth-action", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "auth-action.html"));
});

// ─────────────────────────────────────────────
// STRIPE WEBHOOK (STEP 1 — RECEIVE ONLY)
// ─────────────────────────────────────────────
app.post(
  "/webhooks/stripe",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    let stripeEventRef;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logError("Webhook signature verification failed", err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    stripeEventRef = db.collection("stripe_events").doc(event.id);
    try {
      await stripeEventRef.create({
        event_id: event.id,
        event_type: event.type,
        received_at: admin.firestore.FieldValue.serverTimestamp(),
        processed: false,
      });
    } catch (err) {
      if (err?.code === 6 || err?.code === "already-exists") {
        return res.status(200).json({ received: true, duplicate: true });
      }
      logError("Failed to persist stripe webhook event", err, { eventId: event.id, eventType: event.type });
      return res.status(500).json({ error: "Failed to persist webhook event" });
    }

    console.log("✅ Stripe Webhook Received:", event.type);

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // ==========================
          // 🚗 PARKING FLOW (NEW)
          // ==========================
          if (session.metadata?.flow === "parking") {
            try {
              const parkingSessionId =
                session.metadata.parkingSessionId ||
                session.metadata.sessionId;

              if (!parkingSessionId) {
                console.warn("⚠️ No parkingSessionId in metadata");
                break;
              }

              const sessionRef = db.collection("parking_sessions").doc(parkingSessionId);
              const sessionSnap = await sessionRef.get();

              if (!sessionSnap.exists) {
                console.warn("⚠️ Parking session not found:", parkingSessionId);
                break;
              }

              const sessionData = sessionSnap.data();

              // 🛑 IDEMPOTENCY CHECK
              if (sessionData.status === "COMPLETED") {
                console.log("⚠️ Session already completed:", parkingSessionId);
                break;
              }

              const now = admin.firestore.FieldValue.serverTimestamp();

              const startTime =
                sessionData.started_at?.toDate?.() ||
                sessionData.arrival_time?.toDate?.() ||
                new Date();

              const endTime = new Date();

              const totalMinutes = Math.max(
                1,
                Math.floor((endTime - startTime) / 60000)
              );

              const totalAmount =
                session.amount_total
                  ? session.amount_total / 100
                  : sessionData.price_charged || 0;

              // ✅ UPDATE SESSION
              await sessionRef.update({
                status: "COMPLETED",
                ended_at: now,
                total_minutes: totalMinutes,
                total_amount: totalAmount,
                stripe_session_id: session.id,
              });

              console.log("✅ Parking session completed:", parkingSessionId);

              // 📧 SEND RECEIPT EMAIL
              const userRef = sessionData.user_id;
              const userSnap = userRef ? await userRef.get() : null;
              const user = userSnap?.exists ? userSnap.data() : {};
              const toEmail = user?.email;

              if (toEmail) {
                const email = buildParkingReceiptEmail({
                  firstName: resolveUserFirstName(user),
                  supportEmail: "support@openspots.app",
                  appUrl: process.env.BASE_URL || "https://openspots.app",
                  zoneNumber: sessionData.zone_number,
                  startTime: startTime.toLocaleString(),
                  endTime: endTime.toLocaleString(),
                  totalMinutes,
                  totalAmount,
                  socials: SOCIALS
                });

                await sendEmail({
                  to: toEmail,
                  subject: email.subject,
                  html: email.html,
                  text: email.text,
                });

                console.log("📧 Parking receipt sent:", toEmail);
              }

            } catch (err) {
              logError("Parking webhook failed", err, { eventId: event.id });
            }

            break; // 🚨 CRITICAL: prevents reservation logic from running
          }

          if (session.mode === "setup") {
            const customerId = session.customer;
            const setupIntentId = session.setup_intent;
            const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
            const paymentMethodId = setupIntent.payment_method;
            const customer = await stripe.customers.retrieve(customerId);
            let userId = customer.metadata.uid;

            if (!userId) {
              const byCamel = await db.collection("users")
                .where("stripeCustomerId", "==", customerId)
                .limit(1)
                .get();
              if (!byCamel.empty) userId = byCamel.docs[0].id;
            }

            if (!userId) {
              const bySnake = await db.collection("users")
                .where("stripe_customer_id", "==", customerId)
                .limit(1)
                .get();
              if (!bySnake.empty) userId = bySnake.docs[0].id;
            }

            if (!userId || !paymentMethodId) {
              logError("Missing uid or payment method from setup session", new Error("Incomplete setup session data"), {
                eventId: event.id,
                customerId,
                paymentMethodId,
              });
              break;
            }

            const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
            const card = pm.card || {};

            await db.collection("users").doc(userId).set({
              stripe_customer_id: customerId,
              stripe_default_payment_method: paymentMethodId,
              hasPaymentMethod: true,
              payment_brand: card.brand || null,
              payment_last4: card.last4 || null,
              payment_exp_month: card.exp_month || null,
              payment_exp_year: card.exp_year || null,
              payment_updated_at: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });

            console.log("✅ Payment method saved for user:", userId);
            try {
              const userSnap = await db.collection("users").doc(userId).get();
              const user = userSnap.exists ? userSnap.data() : {};
              const toEmail = user?.email || customer?.email;

              if (toEmail) {
                const email = buildPaymentMethodAddedEmail({
                  firstName: resolveUserFirstName(user),
                  appUrl: process.env.BASE_URL || "https://openspots.app",
                  supportEmail: "support@openspots.app",
                  cardBrand: card.brand || null,
                  last4: card.last4 || null,
                  expMonth: card.exp_month || null,
                  expYear: card.exp_year || null,
                  socials: SOCIALS
                });

                await sendEmail({ to: toEmail, subject: email.subject, html: email.html, text: email.text });
                console.log("✅ Payment method email sent:", toEmail);
              } else {
                console.log("⚠️ No email found for user; skipping payment method email");
              }
            } catch (e) {
              logError("Payment method email failed", e, { eventId: event.id, userId });
            }
            break;
          }

          const { userId, eventId, spotId } = session.metadata || {};

          console.log("🧠 Phase 3: Finalizing reservation", { userId, eventId, spotId });

          if (!userId || !eventId || !spotId) {
            throw new Error(`Missing metadata in checkout session: ${JSON.stringify(session.metadata || {})}`);
          }

          const spotRef = db.collection("spots").doc(spotId);
          const reservationRef = db.collection("reservations").doc();
          let reservationEmailData = null;

          try {
            await db.runTransaction(async (tx) => {
              const spotSnap = await tx.get(spotRef);
              if (!spotSnap.exists) throw new Error("Spot does not exist");

              const spotData = spotSnap.data();
              if (!spotData.is_available) throw new Error("Spot already reserved");

              const eventRef = db.collection("events").doc(eventId);
              const eventSnap = await tx.get(eventRef);
              const eventData = eventSnap.exists ? eventSnap.data() : null;

              const venueRef = eventData?.venue_ref || null;
              const eventDate = eventData?.event_date || null;
              const venueSnap = venueRef ? await tx.get(venueRef) : null;
              const venueName = venueSnap?.data()?.name || "Venue";
              const eventName = eventData?.event_name || "Event";
              const spotLabel = spotData.spot_id || "SPOT";
              const reservationId = reservationRef.id;
              const appUrl = process.env.BASE_URL || "https://openspots.app";
              const checkinUrl = `${appUrl}/checkin.html?reservationId=${reservationId}`;
              const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(checkinUrl)}`;
              const confirmationCode = reservationId.slice(-6).toUpperCase();

              const reservationData = {
                user_id: db.collection("users").doc(userId),
                venue_id: venueRef,
                spot_ref: spotRef,
                event_ref: eventRef,
                venue_name: venueName,
                event_name: eventName,
                start_time: eventDate,
                spot_label: spotLabel,
                price_paid: session.amount_total / 100,
                status: "confirmed",
                created_at: admin.firestore.FieldValue.serverTimestamp(),
              };

              if (session.id) reservationData.stripe_session_id = session.id;
              if (session.payment_intent) reservationData.payment_intent = session.payment_intent;

              tx.update(spotRef, {
                is_available: false,
                reserved_by: db.collection("users").doc(userId),
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
              });
              tx.set(reservationRef, reservationData);

              reservationEmailData = {
                venueName,
                eventName,
                spotLabel,
                qrCodeUrl,
                confirmationCode
              };
            });
          } catch (err) {
            if (err?.message === "Spot already reserved") {
              console.log("Spot already reserved — ignoring duplicate webhook");
              break;
            }
            throw err;
          }

          console.log("✅ Reservation created & spot locked");
          if (reservationEmailData) {
            try {
              const userSnap = await db.collection("users").doc(userId).get();
              const user = userSnap.exists ? userSnap.data() : {};
              const toEmail =
                user?.email ||
                session.customer_details?.email ||
                session.customer_email;

              if (toEmail) {
                const email = buildReservationConfirmationEmail({
                  to: toEmail,
                  firstName: resolveUserFirstName(user),
                  venueName: reservationEmailData.venueName,
                  eventName: reservationEmailData.eventName,
                  spotLabel: reservationEmailData.spotLabel,
                  qrCodeUrl: reservationEmailData.qrCodeUrl,
                  confirmationCode: reservationEmailData.confirmationCode,
                  appUrl: process.env.BASE_URL || "https://openspots.app",
                  supportEmail: "support@openspots.app"
                });

                await sendEmail({ to: toEmail, subject: email.subject, html: email.html, text: email.text });
                console.log("✅ Reservation confirmation email sent:", toEmail);
              } else {
                console.log("⚠️ No email found for user; skipping reservation confirmation email");
              }
            } catch (e) {
              logError("Reservation confirmation email failed", e, { eventId: event.id, userId });
            }
          }
          break;
        }
        default:
          break;
      }

      await stripeEventRef.set({
        processed: true,
        processed_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (err) {
      logError("Stripe webhook processing failed", err, { eventId: event.id, eventType: event.type });
      try {
        await stripeEventRef.set({
          processed: false,
          failed_at: admin.firestore.FieldValue.serverTimestamp(),
          error_message: err?.message || "Webhook processing failed",
        }, { merge: true });
      } catch (markErr) {
        logError("Failed to persist stripe webhook failure status", markErr, { eventId: event.id });
      }
      return res.status(500).json({ error: "Webhook processing failed" });
    }

    res.json({ received: true });
  }
);
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Keep-alive ping endpoint (Render)
app.get("/ping", (req, res) => {
  res.status(200).send("pong");
});

app.get("/test-welcome-email", async (req, res) => {
  try {
    const email = buildWelcomeEmail({
      firstName: "Nemesio",
      appUrl: "https://openspots.app",
      supportEmail: "support@openspots.app",
    });

    await sendEmail({
      to: "openspotsapp@gmail.com",
      subject: email.subject,
      html: email.html,
      text: email.text,
    });

    res.send("Welcome email sent");
  } catch (err) {
    console.error(err);
    res.status(500).send("Welcome email failed");
  }
});

// Stripe success finalizer
app.get("/stripe/success", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const flow = req.query.flow;
    if (!sessionId) return res.status(400).send("Missing session ID");

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).send("Payment not completed");
    }

    // TODO (next step): save reservation using session.metadata

    if (flow === "reservation") {
      return res.redirect(`${process.env.BASE_URL}/my-spots.html?tab=reservations`);
    }

    res.redirect(`${process.env.BASE_URL}/my-spots.html`);
  } catch (err) {
    logError("Stripe success handler failed", err, { route: "/stripe/success" });
    res.status(500).send("Stripe success failed");
  }
});

// API endpoint for Urbiotica spot status
app.get("/api/spot/:id", async (req, res) => {
    try {
        const result = await getSpotStatus(req.params.id);

        res.json({
            spot: req.params.id,
            status: result.status,
            raw: result.raw
        });
    } catch (error) {
        console.error("Error fetching Urbiotica spot:", error);
        res.status(500).json({ error: "Failed to get spot status" });
    }
});

// Debug endpoint to inspect live AMQP cache
app.get("/api/debug/live-cache", (req, res) => {
    res.json(liveSpotCache);
});

app.post("/users/register-device", async (req, res) => {
    try {
        const { uid, token } = req.body || {};

        if (!uid || !token) {
            return res.status(400).json({ error: "Missing uid or token" });
        }

        const userRef = db.collection("users").doc(uid);
        const userSnap = await userRef.get();

        if (!userSnap.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const userData = userSnap.data() || {};
        const updatePayload = {
            fcm_tokens: admin.firestore.FieldValue.arrayUnion(token),
        };

        if (userData.notifications_enabled === undefined) {
            updatePayload.notifications_enabled = true;
        }

        await userRef.set(updatePayload, { merge: true });
        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to register device token:", err);
        return res.status(500).json({ error: "Failed to register device" });
    }
});

// ─────────────────────────────────────────────
// REAL-TIME UPDATES → SSE STREAM
// ─────────────────────────────────────────────
app.get("/events/spot-updates", (req, res) => {
    console.log("📡 SSE client connected");

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Send current cache immediately
    res.write(`data: ${JSON.stringify(liveSpotCache)}\n\n`);

    // Listener for AMQP realtime events
    const handler = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    amqpEvents.on("spot-update", handler);

    // When client closes connection
    req.on("close", () => {
        console.log("❌ SSE client disconnected");
        amqpEvents.off("spot-update", handler);
    });
});

app.post("/start-metered-session", async (req, res) => {
    try {
        const { zone_id } = req.body;

        if (!zone_id) {
            return res.status(400).json({ error: "Missing zone_id" });
        }

        await db.doc(zone_id).update({
            is_available: false,
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to start metered session:", err);
        return res.status(500).json({ error: "Failed to start session" });
    }
});

app.post("/api/parking/create-pending", async (req, res) => {
    try {
        const { zone_id, zone_number, user_id } = req.body;

        if (!zone_id || !zone_number || !user_id) {
            return res.status(400).json({ error: "Missing zone_id, zone_number, or user_id" });
        }

        const sessionRef = await db.collection("parking_sessions").add({
            status: "PENDING",
            pending_started_at: admin.firestore.FieldValue.serverTimestamp(),
            arrival_time: admin.firestore.FieldValue.serverTimestamp(),
            created_at: admin.firestore.FieldValue.serverTimestamp(),
            zone_id: db.doc(zone_id),
            zone_number,
            user_id: db.collection("users").doc(user_id)
        });

        console.log("🟢 CREATE PENDING", {
            sessionId: sessionRef.id,
            zone_number,
            user_id,
            project: process.env.FIREBASE_PROJECT_ID,
            instance: process.env.RENDER_INSTANCE_ID || "local"
        });

        return res.json({ sessionId: sessionRef.id });
    } catch (err) {
        console.error("Failed to create pending session:", err);
        return res.status(500).json({ error: "Failed to create pending session" });
    }
});

app.post("/api/send-welcome-email", async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: "Missing uid" });

        const userSnap = await db.collection("users").doc(uid).get();
        if (!userSnap.exists) {
            return res.status(404).json({ error: "User not found" });
        }

        const user = userSnap.data();
        if (!user.email) {
            return res.status(400).json({ error: "User has no email" });
        }

        const email = buildWelcomeEmail({
            firstName: resolveUserFirstName(user),
            appUrl: process.env.BASE_URL || "https://openspots.app",
            supportEmail: "support@openspots.app"
        });

        await sendEmail({
            to: user.email,
            subject: email.subject,
            html: email.html,
            text: email.text
        });

        console.log("✅ Welcome email sent to:", user.email);
        res.json({ success: true });
    } catch (err) {
        console.error("Welcome email error:", err);
        res.status(500).json({ error: "Failed to send welcome email" });
    }
});

app.post("/api/parking/confirm-session", async (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: "Missing sessionId" });
        }

        console.log("🟡 CONFIRM SESSION REQUEST", {
            sessionId,
            project: process.env.FIREBASE_PROJECT_ID,
            instance: process.env.RENDER_INSTANCE_ID || "local"
        });

        const sessionRef = db.collection("parking_sessions").doc(sessionId);

        console.log("🔎 Confirm attempt for session:", sessionId);

        let sessionSnap;
        for (let i = 0; i < 3; i++) {
            sessionSnap = await sessionRef.get();

            if (sessionSnap.exists) break;

            console.warn(`⏳ Session not found, retrying... attempt ${i + 1}`);
            await new Promise((r) => setTimeout(r, 300));
        }

        console.log("🔍 CONFIRM LOOKUP RESULT", {
            exists: sessionSnap.exists,
            sessionId
        });

        if (!sessionSnap.exists) {
            console.warn("⚠️ Session not found by ID, attempting fallback lookup");

            const { user_id, zone_number } = req.body;

            if (!user_id || !zone_number) {
                return res.status(404).json({ error: "Session not found and no fallback data" });
            }

            const userRef = db.collection("users").doc(user_id);

            // Avoid brittle query combinations (in + orderBy) that can throw index/precondition errors.
            // Query broadly by user + zone, then filter/sort in memory.
            const [fallbackByRef, fallbackByUid] = await Promise.all([
                db
                    .collection("parking_sessions")
                    .where("user_id", "==", userRef)
                    .where("zone_number", "==", zone_number)
                    .limit(20)
                    .get(),
                db
                    .collection("parking_sessions")
                    .where("user_id", "==", user_id)
                    .where("zone_number", "==", zone_number)
                    .limit(20)
                    .get(),
            ]);

            const candidatesMap = new Map();
            for (const d of [...fallbackByRef.docs, ...fallbackByUid.docs]) {
                candidatesMap.set(d.id, d);
            }
            const candidates = Array.from(candidatesMap.values()).filter((d) => {
                const s = typeof d.data()?.status === "string" ? d.data().status.toUpperCase() : "";
                return s === "PENDING" || s === "EXPIRED";
            });

            candidates.sort((a, b) => {
                const ad = a.data() || {};
                const bd = b.data() || {};
                const aTs =
                    ad.pending_started_at?.toMillis?.() ??
                    ad.created_at?.toMillis?.() ??
                    ad.expired_at?.toMillis?.() ??
                    0;
                const bTs =
                    bd.pending_started_at?.toMillis?.() ??
                    bd.created_at?.toMillis?.() ??
                    bd.expired_at?.toMillis?.() ??
                    0;
                return bTs - aTs;
            });

            if (candidates.length === 0) {
                console.error("❌ Fallback also failed");
                return res.status(404).json({ error: "Session not found" });
            }

            const fallbackDoc = candidates[0];
            sessionSnap = fallbackDoc;

            console.log("♻️ Fallback session recovered:", fallbackDoc.id);
        }

        const data = sessionSnap.data();
        const sessionIdToUse = sessionSnap.id;
        const sessionRefToUse = sessionSnap.ref;
        const status = typeof data.status === "string" ? data.status.toUpperCase() : "";
        console.log("🔁 Confirming session with status:", status);
        const isRecoverable = status === "PENDING" || status === "EXPIRED";

        if (!isRecoverable) {
            return res.status(409).json({
                error: "Session is not recoverable",
                status
            });
        }

        let zoneData = {};
        if (data.zone_id) {
            const zoneRef =
                typeof data.zone_id === "string" ? db.doc(data.zone_id) : data.zone_id;
            const zoneSnap = await zoneRef.get();
            if (zoneSnap.exists) {
                zoneData = zoneSnap.data() || {};
            }
        }

        const ratePerMinute =
            typeof zoneData.rate_per_hour === "number"
                ? Number((zoneData.rate_per_hour / 60).toFixed(6))
                : 0;

        await sessionRefToUse.update({
            status: "ACTIVE",
            started_at: admin.firestore.FieldValue.serverTimestamp(),
            activated_at: admin.firestore.FieldValue.serverTimestamp(),
            rate_per_minute: ratePerMinute,
            regulation_type: zoneData.regulation_type,
            sensor_id: data.zone_number,
            payment_method: "MOBILE",
            price_charged: 0,
            total_minutes: 0
        });

        console.log("✅ Session confirmed:", sessionIdToUse);

        if (data.zone_id) {
            const zoneRef =
                typeof data.zone_id === "string" ? db.doc(data.zone_id) : data.zone_id;
            await zoneRef.update({
                is_available: false,
                last_updated: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        // Send "parking started" email
        try {
            const userRef = data.user_id; // users/<uid> doc ref
            const userSnap = userRef ? await userRef.get() : null;
            const user = userSnap?.exists ? userSnap.data() : {};
            const toEmail = user?.email;

            if (toEmail) {
                const email = buildParkingStartedEmail({
                    firstName: resolveUserFirstName(user),
                    supportEmail: "support@openspots.app",
                    appUrl: process.env.BASE_URL || "https://openspots.app",
                    zoneNumber: data.zone_number,
                    startedAt: "Just now",
                    ratePerHour: zoneData?.rate_per_hour,
                    socials: SOCIALS
                });

                await sendEmail({ to: toEmail, subject: email.subject, html: email.html, text: email.text });
                console.log("✅ Parking started email sent:", toEmail);
            }
        } catch (e) {
            console.error("Parking started email failed:", e);
        }

        return res.json({ success: true, sessionId: sessionIdToUse });
    } catch (err) {
        console.error("Failed to confirm parking session:", err);
        return res.status(500).json({ error: "Failed to confirm session" });
    }
});

app.post("/end-metered-session", async (req, res) => {
    try {
        const { session_id, zone_id } = req.body;

        if (!session_id || !zone_id) {
            return res.status(400).json({ error: "Missing session_id or zone_id" });
        }
        // NOTE: Session completion + receipt email now handled via Stripe webhook

        const zoneRef = db.doc(zone_id);

        await zoneRef.update({
            is_available: true,
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        });

        const pendingSnap = await db
            .collection("parking_sessions")
            .where("status", "==", "PENDING")
            .where("zone_id", "==", zoneRef)
            .get();

        for (const pendingDoc of pendingSnap.docs) {
            await pendingDoc.ref.update({
                status: "EXPIRED",
                expired_at: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to end metered session:", err);
        return res.status(500).json({ error: "Failed to end session" });
    }
});

// Admin: lock a metered spot
app.post("/api/lock-metered-spot", async (req, res) => {
    try {
        const { zoneDocId } = req.body;

        if (!zoneDocId) {
            return res.status(400).json({ error: "Missing zoneDocId" });
        }

        const zoneRef = admin
            .firestore()
            .collection("private_metered_parking")
            .doc(zoneDocId);

        await zoneRef.update({
            is_available: false,
            last_updated: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json({ success: true });
    } catch (err) {
        console.error("Failed to lock metered spot:", err);
        return res.status(500).json({ error: "Failed to lock spot" });
    }
});

// Create Stripe Checkout session
app.post("/create-checkout-session", async (req, res) => {
    try {
        const body = req.body || {};
        const psId = body.parkingSessionId || "";
        const { eventId, spotId, price, userId, flow } = body;
        const safeFlow = flow || "parking";
        const { uid, email } = await resolveIdentityFromRequest(req);

        if (!spotId || !price) {
            return res.status(400).json({ error: "Missing required data" });
        }

        if (flow === "parking" && !body.parkingSessionId) {
            return res.status(400).json({ error: "Missing parkingSessionId for parking flow" });
        }

        const session = await stripe.checkout.sessions.create({
            mode: "payment",
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: flow === "parking"
                                ? "OpenSpots Parking Session"
                                : "OpenSpots Reservation",
                            description: `Spot ${spotId}`,
                        },
                        unit_amount: price * 100,
                    },
                    quantity: 1,
                },
            ],
            metadata: {
                userId: userId || uid || "",
                spotId: spotId || "",
                eventId: eventId || "",
                flow: safeFlow,
                parkingSessionId: body.parkingSessionId || ""
            },
            success_url: `openspots://stripe-success?flow=${safeFlow}&parkingSessionId=${psId}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: "openspots://stripe-cancel",
        });

        const url = await resolveCheckoutSessionUrl(session);
        console.log({
            level: "info",
            message: "Checkout session created",
            context: {
                route: "/create-checkout-session",
                uid: uid || null,
                email: email || null,
                hasUrl: Boolean(url),
                sessionId: session.id,
            },
            timestamp: new Date().toISOString(),
        });

        res.json({ url, sessionId: session.id });
    } catch (error) {
        logError("Stripe checkout session creation failed", error, { route: "/create-checkout-session" });
        res.status(500).json({ error: "Failed to create checkout session" });
    }
});

const createPaymentIntent = async ({
    uid,
    email,
    amount,
    currency = "usd",
    spotId,
    eventId,
    flow,
    metadata = {},
}) => {
    const customerId = await getOrCreateStripeCustomerId({ uid, email });
    const idempotencyKey = buildPaymentIntentIdempotencyKey({
        uid,
        amount,
        currency,
        spotId,
        eventId,
    });

    const paymentIntent = await stripe.paymentIntents.create(
        {
            amount,
            currency: String(currency).toLowerCase(),
            customer: customerId,
            automatic_payment_methods: { enabled: true },
            metadata: {
                uid,
                spotId: spotId || "",
                eventId: eventId || "",
                flow: flow || "",
                ...metadata,
            },
        },
        { idempotencyKey }
    );

    return { paymentIntent, customerId };
};

app.post("/create-payment-intent", async (req, res) => {
    try {
        const {
            uid,
            email,
            amount,
            currency,
            spotId,
            eventId,
            flow,
            metadata,
        } = req.body;

        if (!uid || !email || !Number.isInteger(amount) || amount <= 0) {
            return res.status(400).json({ error: "Missing or invalid uid/email/amount" });
        }

        const { paymentIntent, customerId } = await createPaymentIntent({
            uid,
            email,
            amount,
            currency,
            spotId,
            eventId,
            flow,
            metadata,
        });

        return res.json({
            paymentIntentId: paymentIntent.id,
            clientSecret: paymentIntent.client_secret,
            customerId,
        });
    } catch (err) {
        logError("Payment intent creation failed", err, { route: "/create-payment-intent" });
        return res.status(500).json({ error: "Failed to create payment intent" });
    }
});

// Create Stripe Setup session
app.post("/create-setup-session", async (req, res) => {
    try {
        const body = req.body || {};
        const identity = await resolveIdentityFromRequest({ ...req, body });
        const uid = identity.uid;
        const email = identity.email;

        if (!uid || !email) {
            return res.status(400).json({ error: "Missing uid or email" });
        }

        // 1. Create or retrieve Stripe customer
        const customerId = await getOrCreateStripeCustomerId({ uid, email });

        const session = await stripe.checkout.sessions.create({
            mode: "setup",
            customer: customerId,
            payment_method_types: ["card"],
            success_url: "openspots://stripe-setup-success",
            cancel_url: "openspots://stripe-cancel",
        });

        const url = await resolveCheckoutSessionUrl(session);
        console.log({
            level: "info",
            message: "Setup session created",
            context: {
                route: "/create-setup-session",
                uid: uid || null,
                email: email || null,
                hasUrl: Boolean(url),
                sessionId: session.id,
            },
            timestamp: new Date().toISOString(),
        });

        res.json({ url, sessionId: session.id });
    } catch (err) {
        logError("Setup session creation failed", err, { route: "/create-setup-session" });
        res.status(500).json({ error: "Failed to create setup session" });
    }
});

app.listen(PORT, () => {
    console.log(`OpenSpots server running on port ${PORT}`);
});
