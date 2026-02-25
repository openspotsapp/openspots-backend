// backend/spotStatus.js
import fetch from "node-fetch";
import { getToken } from "./urbiotica.js";

const ORGANISM = process.env.URBIO_ORGANISM;
const PROJECT = process.env.URBIO_PROJECT;
const BASE_URL = "https://uadmin.urbiotica.net/v2";

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Helper to add timeout to fetch calls.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Safely extract the latest measurement value from the Urbiotica response.
 * Expected shape:
 *   [ { measurements: [ { value: <number>, timestamp: <string>, ... } ] } ]
 */
function extractStatusValue(data) {
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0];
  const measurements = first?.measurements;

  if (!Array.isArray(measurements) || measurements.length === 0) return null;

  const latest = measurements[0];

  return typeof latest.value === "number" ? latest.value : null;
}

/**
 * Get the vehicle status for a given spot:
 *   0 => free
 *   1 => occupied
 *  -1 => undefined/down
 *
 * Returns:
 *   { status, raw }
 * where:
 *   status: number | null  (normalized value or null if not available)
 *   raw:    any            (full JSON payload for debugging)
 */
export async function getSpotStatus(spotId) {
  if (!spotId) {
    throw new Error("spotId is required");
  }

  if (!ORGANISM || !PROJECT) {
    console.error("[Urbiotica] Missing env vars (URBIO_ORGANISM / URBIO_PROJECT).");
    throw new Error("Urbiotica project configuration missing");
  }

  const token = await getToken();

  const url = `${BASE_URL}/parking/${ORGANISM}/projects/${PROJECT}/elements/${spotId}/phenomena`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: { IDENTITY_KEY: token }
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[Urbiotica] Spot status request failed for spot ${spotId}:`,
        res.status,
        res.statusText,
        text
      );
      throw new Error(`Urbiotica spot status failed with status ${res.status}`);
    }

    const data = await res.json().catch(err => {
      console.error("[Urbiotica] Failed to parse JSON for spot", spotId, err);
      throw new Error("Invalid JSON from Urbiotica spot status");
    });

    const status = extractStatusValue(data);

    if (status === null) {
      console.warn("[Urbiotica] No valid status value found for spot", spotId);
    }

    // You can return just `status` if you prefer, but this gives more visibility.
    return { status, raw: data };
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[Urbiotica] Spot status request timed out for spot", spotId);
      throw new Error("Urbiotica spot status request timed out");
    }

    console.error("[Urbiotica] Error getting spot status for spot", spotId, err);
    throw err;
  }
}
