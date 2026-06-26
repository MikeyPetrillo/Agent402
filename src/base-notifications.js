// Base Notifications API — env-gated, optional.
//
// Wraps the Base Dashboard Notifications API so Agent402 can notify users
// who have pinned the app. If BASE_NOTIFICATIONS_API_KEY is not set, every
// export is a silent no-op — the server runs identically without it.
//
// API surface:
//   GET  /api/v1/notifications/users         — list users who pinned the app
//   POST /api/v1/notifications/users/status   — check notification status for addresses
//   POST /api/v1/notifications/send           — send a notification
//
// Rate limit: 20 requests/min/IP.
// Title: 30 chars max.  Body: 200 chars max.

const API_KEY = (process.env.BASE_NOTIFICATIONS_API_KEY || "").trim();
const BASE_URL = "https://api.developer.coinbase.com/onchainkit";

export function baseNotificationsEnabled() {
  return !!API_KEY;
}

/**
 * Fetch users who pinned the app on Base.
 * Returns { ok, users } on success, { ok: false, error } on failure.
 */
export async function getBaseAppUsers() {
  if (!API_KEY) return { ok: false, error: "no-api-key" };
  try {
    const res = await fetch(`${BASE_URL}/api/v1/notifications/users`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `http-${res.status}`, detail: body };
    }
    const data = await res.json();
    return { ok: true, users: data };
  } catch (e) {
    console.error("[base-notifications] getBaseAppUsers failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Check notification status for a list of wallet addresses.
 * @param {string[]} targetAddresses — wallet addresses to check
 * Returns { ok, statuses } on success, { ok: false, error } on failure.
 */
export async function checkBaseNotificationStatus(targetAddresses) {
  if (!API_KEY) return { ok: false, error: "no-api-key" };
  if (!Array.isArray(targetAddresses) || targetAddresses.length === 0) {
    return { ok: false, error: "no-addresses" };
  }
  try {
    const res = await fetch(`${BASE_URL}/api/v1/notifications/users/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ wallet_addresses: targetAddresses }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `http-${res.status}`, detail: body };
    }
    const data = await res.json();
    return { ok: true, statuses: data };
  } catch (e) {
    console.error("[base-notifications] checkStatus failed:", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Send a notification to one or more wallet addresses.
 * @param {string[]} targetAddresses — wallet addresses to notify
 * @param {string}   title           — notification title (max 30 chars)
 * @param {string}   body            — notification body  (max 200 chars)
 * Returns { ok, result } on success, { ok: false, error } on failure.
 */
export async function sendBaseNotification(targetAddresses, title, body) {
  if (!API_KEY) return { ok: false, error: "no-api-key" };
  if (!Array.isArray(targetAddresses) || targetAddresses.length === 0) {
    return { ok: false, error: "no-addresses" };
  }
  if (!title || typeof title !== "string") {
    return { ok: false, error: "title-required" };
  }
  if (!body || typeof body !== "string") {
    return { ok: false, error: "body-required" };
  }
  // Enforce API limits.
  const trimmedTitle = title.slice(0, 30);
  const trimmedBody = body.slice(0, 200);

  try {
    const res = await fetch(`${BASE_URL}/api/v1/notifications/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        wallet_addresses: targetAddresses,
        title: trimmedTitle,
        body: trimmedBody,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `http-${res.status}`, detail };
    }
    const data = await res.json();
    return { ok: true, result: data };
  } catch (e) {
    console.error("[base-notifications] send failed:", e.message);
    return { ok: false, error: e.message };
  }
}
