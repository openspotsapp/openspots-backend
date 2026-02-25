// backend/urbiotica.js
import fetch from "node-fetch";

const USERID = process.env.URBIO_USERID;
const PASSWORD = process.env.URBIO_PASSWORD;
const ORGANISM = process.env.URBIO_ORGANISM;
const PROJECT = process.env.URBIO_PROJECT;

let AUTH_TOKEN = null;
let TOKEN_EXPIRES_AT = 0;

// Default timeout for all Urbiotica calls (ms)
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Small helper to add a timeout to fetch calls.
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
 * Get (and cache) the Urbiotica auth token.
 * - Reuses the token until it expires (5 hours).
 * - Throws an error if auth fails so the caller can handle it.
 */
export async function getToken() {
  const now = Date.now();

  // Reuse cached token if still valid
  if (AUTH_TOKEN && now < TOKEN_EXPIRES_AT) {
    return AUTH_TOKEN;
  }

  if (!ORGANISM || !USERID || !PASSWORD) {
    console.error("[Urbiotica] Missing auth env vars (URBIO_ORGANISM / URBIO_USERID / URBIO_PASSWORD).");
    throw new Error("Urbiotica auth configuration missing");
  }

  const authUrl = `https://uadmin.urbiotica.net/v2/auth/${ORGANISM}`;

  try {
    const response = await fetchWithTimeout(authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userid: USERID,
        password: PASSWORD,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[Urbiotica] Auth failed:", response.status, response.statusText, text);
      throw new Error(`Urbiotica auth failed with status ${response.status}`);
    }

    // Urbiotica returns the token as plain text, usually quoted.
    const raw = await response.text();
    const token = raw.replace(/"/g, "").trim();

    if (!token) {
      console.error("[Urbiotica] Empty auth token received.");
      throw new Error("Urbiotica returned an empty token");
    }

    AUTH_TOKEN = token;
    TOKEN_EXPIRES_AT = now + 5 * 60 * 60 * 1000; // 5 hours

    console.log("[Urbiotica] Auth token refreshed.");
    return AUTH_TOKEN;
  } catch (err) {
    if (err.name === "AbortError") {
      console.error("[Urbiotica] Auth request timed out.");
      throw new Error("Urbiotica auth request timed out");
    }

    console.error("[Urbiotica] Error fetching auth token:", err);
    throw err;
  }
}
