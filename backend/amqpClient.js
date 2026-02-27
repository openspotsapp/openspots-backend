import dotenv from "dotenv";
dotenv.config();
// backend/amqpClient.js
import amqp from "amqplib";
import EventEmitter from "events";
import { sensorProcessor } from "../server/sensors/sensorProcessor.js";

// ─────────────────────────────────────────────
// ENV VARIABLES
// ─────────────────────────────────────────────
const ORGANISM = process.env.URBIO_ORGANISM;
const PROJECT  = process.env.URBIO_PROJECT;
const USERID   = process.env.URBIO_USERID;
const PASSWORD = process.env.URBIO_PASSWORD;

const AMQP_HOST = process.env.AMQP_HOST; 
// Example (once Sergi sends it):
// amqps://OpenSpots_user:vTb2V2n310WQ@broker.urbiotica.net:5671

if (!ORGANISM || !PROJECT || !USERID || !PASSWORD) {
  console.error("[AMQP] Missing environment variables. Check .env");
}

if (!AMQP_HOST) {
  console.error("[AMQP] Missing AMQP_HOST in .env — waiting for credentials from Sergi.");
}

// ─────────────────────────────────────────────
// LIVE CACHE — used by REST endpoints & UI
// liveSpotCache[elementId] = { status, ts, raw }
// ─────────────────────────────────────────────
export const liveSpotCache = {};

// ─────────────────────────────────────────────
// EVENT EMITTER — your server.js will use this
// to push updates to attendees/web clients
// ─────────────────────────────────────────────
export const amqpEvents = new EventEmitter();

// ─────────────────────────────────────────────
// THE QUEUE NAME (as created by Sergi)
// ─────────────────────────────────────────────
const QUEUE_NAME = "OpenSpots-prj508419"; // provided by Sergi

// ─────────────────────────────────────────────
// AMQP CONNECTION HANDLING
// ─────────────────────────────────────────────
let connection = null;
let channel = null;

// AUTO-RECONNECT LOOP
async function connectAMQP() {
  try {
    console.log("🔌 [AMQP] Connecting to Urbiotica…");

    connection = await amqp.connect(AMQP_HOST, {
      username: USERID,
      password: PASSWORD
    });

    connection.on("error", (err) => {
      console.error("❌ [AMQP] Connection error:", err.message);
    });

    connection.on("close", () => {
      console.warn("⚠️ [AMQP] Connection closed. Reconnecting in 3s…");
      setTimeout(connectAMQP, 3000);
    });

    channel = await connection.createChannel();

    console.log("📡 [AMQP] Connected. Subscribing to queue:", QUEUE_NAME);

    await channel.consume(
      QUEUE_NAME,
      (msg) => {
        if (msg !== null) {
          handleMessage(msg);
        }
      },
      { noAck: true } // passive consumption with autoACK
    );

    console.log("🚀 [AMQP] Listening for sensor events…");

  } catch (err) {
    console.error("❌ [AMQP] Connection failed:", err.message);
    console.log("⏳ Retrying in 3 seconds…");
    setTimeout(connectAMQP, 3000);
  }
}

// ─────────────────────────────────────────────
// MESSAGE HANDLER — parses & stores each event
// ─────────────────────────────────────────────
function handleMessage(msg) {
  try {
    const payload = JSON.parse(msg.content.toString());

    // Urbiotica standard format example:
    // {
    //   "element": "usp-153323",
    //   "phenomenon": "vehicle",
    //   "value": 0 or 1,
    //   "timestamp": "2024-12-04T15:22:11Z"
    // }

    const elementId = payload.element;
    const statusValue = payload.value;
    const ts = payload.timestamp || Date.now();

    // Update local cache
    liveSpotCache[elementId] = {
      status: statusValue,
      ts,
      phenomenon: payload.phenomenon,
      raw: payload
    };

    // Forward event to server.js
    amqpEvents.emit("spot-update", {
      elementId,
      status: statusValue,
      timestamp: ts,
      phenomenon: payload.phenomenon,
      raw: payload
    });

    sensorProcessor(payload).catch((err) => {
      console.error("❌ [SENSOR] Processing error:", err.message);
    });

    console.log(
      `📨 [AMQP] ${elementId} → ${payload.phenomenon}: ${statusValue}`
    );

  } catch (err) {
    console.error("❌ [AMQP] Message parse error:", err);
  }
}

// ─────────────────────────────────────────────
// START CLIENT
// ─────────────────────────────────────────────
connectAMQP();

// Export channel if needed
export default {
  connection,
  channel,
  liveSpotCache,
  amqpEvents
};
