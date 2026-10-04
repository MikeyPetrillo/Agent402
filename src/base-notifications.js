// Base Notifications API: env-gated presence flag only.
//
// BASE_NOTIFICATIONS_API_KEY (from Base Dashboard) would let Agent402 notify
// users who pinned the app. The list/status/send helpers were removed on
// 2026-10-04 because nothing ever called them; this flag is all that remains,
// reported on the health check's `flags`. Rebuild the client against the Base
// Dashboard Notifications API if the feature is ever wanted.

const API_KEY = (process.env.BASE_NOTIFICATIONS_API_KEY || "").trim();

export function baseNotificationsEnabled() {
  return !!API_KEY;
}
