"use client";

/** Web Push wiring. iOS only exposes this to installed PWAs, so the UI has to
 *  cope with "supported but not yet installed" as a normal state. */

/** "error" covers the cases where permission was granted but the subscription
 *  itself failed — a blocked push endpoint, a bad VAPID key, a rejected POST.
 *  Without it a failure reads as success, because Notification.permission is
 *  "granted" either way. */
export type PushResult = "granted" | "denied" | "unsupported" | "error";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function pushPermission(): NotificationPermission | "unsupported" {
  if (!pushSupported()) return "unsupported";
  return Notification.permission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

/** Asks for permission, subscribes, and posts the subscription to the server.
 *  Safe to call repeatedly — re-subscribing refreshes an expired endpoint. */
export async function ensurePushSubscription(): Promise<PushResult> {
  if (!pushSupported()) return "unsupported";

  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!key) return "unsupported";

  let permission: NotificationPermission;
  try {
    permission =
      Notification.permission === "granted"
        ? "granted"
        : await Notification.requestPermission();
  } catch {
    return "error";
  }
  if (permission !== "granted") return "denied";

  // Everything past the permission prompt can fail on its own — a blocked push
  // service, a malformed key, an offline POST. Report that as "error", never as
  // "granted", so the UI can't promise nudges that will never arrive.
  try {
    const reg =
      (await navigator.serviceWorker.getRegistration()) ?? (await registerServiceWorker());
    if (!reg) return "error";
    await navigator.serviceWorker.ready;

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
      }));

    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return "error";

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
      }),
    });
    if (!res.ok) return "error";

    return "granted";
  } catch {
    return "error";
  }
}

/** Unsubscribes this device and forgets it server-side. Called on sign-out so
 *  the next person to use this browser doesn't inherit the nudges. */
export async function clearPushSubscription(): Promise<void> {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).catch(() => {});
  } catch {
    // Sign-out must never be blocked by push teardown.
  }
}
