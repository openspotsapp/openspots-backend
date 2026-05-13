import dotenv from "dotenv";
dotenv.config();
// backend/amqpClient.js
import amqp from "amqplib";
import EventEmitter from "events";
import os from "os";
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
const EXCHANGE_NAME = null;
const ROUTING_KEY = null;
const QUEUE_ASSERTED = false;
const CONSUME_OPTIONS = { noAck: true }; // passive consumption with autoACK
const AMQP_CONSUMER_ENABLED = process.env.AMQP_CONSUMER_ENABLED === "true";

function getRenderRuntimeContext() {
  return {
    render: process.env.RENDER ?? null,
    serviceId: process.env.RENDER_SERVICE_ID ?? null,
    serviceName: process.env.RENDER_SERVICE_NAME ?? null,
    instanceId: process.env.RENDER_INSTANCE_ID ?? null,
    externalHostname: process.env.RENDER_EXTERNAL_HOSTNAME ?? null,
  };
}

// ─────────────────────────────────────────────
// AMQP CONNECTION HANDLING
// ─────────────────────────────────────────────
let connection = null;
let channel = null;
let heartbeatInterval = null;

function sanitizeAmqpHost(host) {
  if (!host) {
    return "(missing)";
  }

  try {
    const url = new URL(host);
    if (url.username || url.password) {
      url.username = "[redacted]";
      url.password = "[redacted]";
    }
    return url.toString();
  } catch {
    return host;
  }
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// AUTO-RECONNECT LOOP
async function connectAMQP() {
  try {
    console.log("🔌 [AMQP] Connecting to Urbiotica…");
    console.log("[AMQP] Host:", sanitizeAmqpHost(AMQP_HOST));
    console.log("[AMQP] Queue:", QUEUE_NAME);
    console.log("[AMQP] Exchange:", EXCHANGE_NAME ?? "(none configured)");
    console.log("[AMQP] Routing key:", ROUTING_KEY ?? "(none configured)");
    console.log(
      `[AMQP] Queue mode: ${QUEUE_ASSERTED ? "asserted before consume" : "only consumed; no assertQueue/bindQueue in this client"}`
    );
    console.log("[AMQP] Consume options:", CONSUME_OPTIONS);

    connection = await amqp.connect(AMQP_HOST, {
      username: USERID,
      password: PASSWORD
    });

    connection.on("error", (err) => {
      console.error("❌ [AMQP] Connection error:", err.message);
    });

    connection.on("close", () => {
      stopHeartbeat();
      console.warn("⚠️ [AMQP] Connection closed. Reconnecting in 3s…");
      setTimeout(connectAMQP, 3000);
    });

    channel = await connection.createChannel();

    channel.on("error", (err) => {
      console.error("❌ [AMQP] Channel error:", err.message);
    });

    channel.on("close", () => {
      stopHeartbeat();
      console.warn("⚠️ [AMQP] Channel closed.");
    });

    console.log("📡 [AMQP] Connected. Subscribing to queue:", QUEUE_NAME);
    console.log("[AMQP] Starting consume()", {
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV ?? null,
      queue: QUEUE_NAME,
      hostname: os.hostname(),
      render: getRenderRuntimeContext(),
      amqpConsumerEnabled: AMQP_CONSUMER_ENABLED,
      timestamp: new Date().toISOString(),
    });

    const consumeResult = await channel.consume(
      QUEUE_NAME,
      (msg) => {
        if (msg !== null) {
          handleMessage(msg);
        }
      },
      CONSUME_OPTIONS
    );

    console.log("[AMQP] Consumer started:", {
      consumerTag: consumeResult.consumerTag,
      queue: QUEUE_NAME,
      exchange: EXCHANGE_NAME,
      routingKey: ROUTING_KEY,
      noAck: CONSUME_OPTIONS.noAck,
      queueAsserted: QUEUE_ASSERTED
    });
    console.log("🚀 [AMQP] Listening for sensor events…");
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
      console.log("[AMQP] Still connected/listening...");
    }, 60000);

  } catch (err) {
    stopHeartbeat();
    console.error("❌ [AMQP] Connection failed:", err.message);
    console.log("⏳ Retrying in 3 seconds…");
    setTimeout(connectAMQP, 3000);
  }
}

// ─────────────────────────────────────────────
// MESSAGE HANDLER — parses & stores each event
// ─────────────────────────────────────────────
function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function firstMeasure(payload) {
  return Array.isArray(payload.measures) ? payload.measures[0] : undefined;
}

function parseVehiclePresence(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") return true;
    if (normalized === "0" || normalized === "false") return false;
  }

  return undefined;
}

function parseBatteryVoltage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUrbioticaPayload(payload) {
  const phenomenon = firstPresent(payload.phenomenonid, payload.phenomenon);
  const measure = firstMeasure(payload);
  const normalized = {
    ...payload,
    phenomenon,
    pomId: firstPresent(payload.pom, payload.pomId, payload.pom_id),
    elementId: firstPresent(payload.elementid, payload.elementId, payload.element_id),
    measurementPointId: firstPresent(payload.pom, payload.measurementPointId, payload.measurement_point_id),
    locationId: firstPresent(payload.zoneid, payload.locationId, payload.location_id),
    zoneId: firstPresent(payload.zoneid, payload.zoneId, payload.zone_id),
    description: firstPresent(payload.pomdesc, payload.description),
    latitude: firstPresent(payload.latitude),
    longitude: firstPresent(payload.longitude),
  };

  if (phenomenon === "vehicle") {
    normalized.vehiclePresence = parseVehiclePresence(measure);
  }

  if (phenomenon === "node_battery") {
    normalized.batteryVoltage = parseBatteryVoltage(measure);
  }

  return normalized;
}

function extractDebugIdentifiers(payload) {
  return {
    pomId: firstPresent(payload.pomId, payload.pom_id, payload.pom?.id, payload.device?.pomId, payload.pom),
    elementId: firstPresent(payload.elementId, payload.element_id, payload.element?.id, payload.element, payload.elementid),
    measurementPointId: firstPresent(
      payload.measurementPointId,
      payload.measurement_point_id,
      payload.measurementPoint?.id,
      payload.pom
    ),
    locationId: firstPresent(payload.locationId, payload.location_id, payload.location?.id, payload.zoneid, payload.zoneId),
    zoneId: firstPresent(payload.zoneId, payload.zone_id, payload.zoneid),
    description: firstPresent(payload.description, payload.pomdesc),
    latitude: firstPresent(payload.latitude),
    longitude: firstPresent(payload.longitude),
    batteryVoltage: firstPresent(payload.batteryVoltage),
    vehiclePresence: firstPresent(
      payload.vehiclePresence,
      payload.vehicle_presence,
      payload.occupied,
      payload.value,
      payload.status,
      payload.phenomenonid === "vehicle" ? parseVehiclePresence(firstMeasure(payload)) : undefined
    ),
  };
}

function handleMessage(msg) {
  const rawMessage = msg.content.toString();
  console.log("[AMQP] Raw message:", rawMessage);

  try {
    const payload = JSON.parse(rawMessage);
    if (!payload || typeof payload !== "object") {
      console.warn("[AMQP] Parsed message is not an object");
      return;
    }

    const normalizedPayload = normalizeUrbioticaPayload(payload);
    const debugIdentifiers = extractDebugIdentifiers(normalizedPayload);
    console.log("[AMQP] Extracted identifiers:", debugIdentifiers);

    // Urbiotica standard format example:
    // {
    //   "element": "usp-153323",
    //   "phenomenon": "vehicle",
    //   "value": 0 or 1,
    //   "timestamp": "2024-12-04T15:22:11Z"
    // }

    const elementId =
      debugIdentifiers.elementId ??
      debugIdentifiers.pomId ??
      debugIdentifiers.measurementPointId ??
      payload.sensor_id ??
      payload.sensorId;
    const statusValue = debugIdentifiers.vehiclePresence;
    const ts = payload.timestamp || Date.now();
    const phenomenon = normalizedPayload.phenomenon;

    // Update local cache
    liveSpotCache[elementId] = {
      status: statusValue,
      ts,
      phenomenon,
      batteryVoltage: debugIdentifiers.batteryVoltage,
      raw: payload
    };

    // Forward event to server.js
    amqpEvents.emit("spot-update", {
      elementId,
      status: statusValue,
      timestamp: ts,
      phenomenon,
      batteryVoltage: debugIdentifiers.batteryVoltage,
      raw: payload
    });

    sensorProcessor(normalizedPayload).catch((err) => {
      console.error("❌ [SENSOR] Processing error:", err.message);
    });

    if (phenomenon === "vehicle") {
      console.log(
        `[AMQP] vehicle ${debugIdentifiers.description ?? "(no description)"} / pom ${debugIdentifiers.measurementPointId ?? "(unknown)"} / zone ${debugIdentifiers.zoneId ?? "(unknown)"} -> occupied=${statusValue}`
      );
    } else if (phenomenon === "node_battery") {
      console.log(
        `[AMQP] node_battery ${debugIdentifiers.description ?? "(no description)"} / pom ${debugIdentifiers.measurementPointId ?? "(unknown)"} / zone ${debugIdentifiers.zoneId ?? "(unknown)"} -> batteryVoltage=${debugIdentifiers.batteryVoltage}`
      );
    } else {
      console.log(
        `📨 [AMQP] ${elementId} → ${phenomenon}: ${statusValue}`
      );
    }

  } catch (err) {
    console.error("❌ [AMQP] Message parse error:", err);
  }
}

// ─────────────────────────────────────────────
// START CLIENT
// ─────────────────────────────────────────────
if (AMQP_CONSUMER_ENABLED) {
  connectAMQP();
} else {
  console.log("[AMQP] Consumer disabled by AMQP_CONSUMER_ENABLED");
}

// Export channel if needed
export default {
  connection,
  channel,
  liveSpotCache,
  amqpEvents
};
