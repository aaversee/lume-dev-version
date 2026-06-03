/**
 * Web Push subscription management.
 * Subscribes the client to push notifications using VAPID.
 *
 * Requests are signed through the key vault (vaultSignRequest) — no key material
 * is passed in or handled here. All functions degrade gracefully (return false)
 * when the browser lacks support or the server has push disabled (no VAPID key).
 */

import { vaultHasKeys, vaultSignRequest } from '@/crypto/keyVault';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    arr[i] = raw.charCodeAt(i);
  }
  return arr;
}

/**
 * Fetch the VAPID public key from the server.
 * Returns null if push is not configured on the server.
 */
async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/push/vapid-key`);
    if (!res.ok) return null;
    const data = (await res.json()) as { vapidPublicKey?: string };
    return data.vapidPublicKey || null;
  } catch {
    return null;
  }
}

/**
 * Subscribe the current browser to push notifications and register it with the
 * server. Reuses an existing browser subscription if present.
 */
export async function subscribeToPush(userId: string): Promise<boolean> {
  if (
    typeof window === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return false;
  }
  if (!vaultHasKeys()) return false;

  const vapidKey = await getVapidKey();
  if (!vapidKey) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
          .buffer as ArrayBuffer,
      }));

    const body = { userId, subscription: subscription.toJSON() };
    const headers = vaultSignRequest('POST', '/push/subscribe', body);

    const res = await fetch(`${API_BASE}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Unsubscribe the current browser from push notifications and clear it on the server.
 */
export async function unsubscribeFromPush(userId: string): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  if (!vaultHasKeys()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }

    const body = { userId };
    const headers = vaultSignRequest('POST', '/push/unsubscribe', body);

    const res = await fetch(`${API_BASE}/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if the browser is currently subscribed to push.
 */
export async function isPushSubscribed(): Promise<boolean> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return false;
  }
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return !!subscription;
  } catch {
    return false;
  }
}
