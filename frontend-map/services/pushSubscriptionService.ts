// Web Push subscribe/unsubscribe -- an officer opts in once (see the
// profile page's toggle), and every alert-worthy event across both
// backends (watchlist match, congestion, camera-down, escalation) can then
// reach their phone/desktop as a real OS notification, even with the app
// closed. See backend-registry's routers/push.py and services/push_service.py
// for the sending side.
import { REGISTRY_API_URL } from '@/config/streams';
import { authHeaders } from '@/lib/apiAuth';

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';

// PushManager.subscribe wants the VAPID public key as a raw Uint8Array, not
// the base64url string it's distributed as everywhere else.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && VAPID_PUBLIC_KEY !== '';
}

/** True if this browser already holds a push subscription -- lets the
 * profile page render its toggle as already-on without a round trip. */
export async function isSubscribed(): Promise<boolean> {
  if (!isPushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  return existing !== null;
}

export async function subscribe(): Promise<void> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  const res = await fetch(`${REGISTRY_API_URL}/push/subscribe`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!res.ok) throw new Error(`Failed to save push subscription: HTTP ${res.status}`);
}

export async function unsubscribe(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  await fetch(`${REGISTRY_API_URL}/push/subscribe`, {
    method: 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ endpoint }),
  }).catch(() => {
    // Best-effort: the local unsubscribe above already stops this device
    // from receiving pushes even if the server-side delete fails to reach
    // the backend (offline, transient network blip).
  });
}
