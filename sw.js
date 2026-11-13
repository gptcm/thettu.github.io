// ConnectChat service worker: Firebase background push + rich notifications.
// Keep this file at the same origin/path as the deployed app.
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

const firebaseConfig = {
  apiKey: "AIzaSyDgafD-CDcaiam_Efh9kJZuEBSZ0kUM9Jw",
  authDomain: "connectchat-6309c.firebaseapp.com",
  projectId: "connectchat-6309c",
  storageBucket: "connectchat-6309c.firebasestorage.app",
  messagingSenderId: "983109078249",
  appId: "1:983109078249:web:aff21aa205b8a4c8b6b478"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

messaging.onBackgroundMessage(async payload => {
  const data = payload.data || {};
  const title = data.title || payload.notification?.title || "ConnectChat";
  const body = data.body || payload.notification?.body || "You have a new notification.";
  const avatar = data.senderAvatar || payload.notification?.image || "./icon-192.png";
  const kind = data.notificationType || "text";
  const options = {
    body,
    icon: avatar,
    image: data.imageUrl || payload.notification?.image || undefined,
    badge: "./icon-192.png",
    tag: `connectchat-${data.messageId || data.callId || Date.now()}`,
    renotify: true,
    // Vibration is supported on some Android browsers; desktop/iOS may ignore it.
    vibrate: kind.includes("call") ? [400, 200, 400, 200, 700] : [180, 90, 180],
    requireInteraction: kind.includes("call"),
    data: {
      url: data.url || "./",
      messageId: data.messageId || "",
      conversationType: data.conversationType || "",
      notificationType: kind,
      callId: data.callId || ""
    },
    actions: [{ action: "open", title: "Open ConnectChat" }]
  };
  if (kind === "voice") options.body = `🎤 ${body}`;
  if (kind === "video") options.body = `🎬 ${body}`;
  if (kind === "incoming_voice_call") options.body = `📞 ${body}`;
  if (kind === "incoming_video_call") options.body = `📹 ${body}`;
  await self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetUrl = new URL(data.url || "./", self.location.origin);
  if (data.messageId) {
    targetUrl.searchParams.set("notificationMessage", data.messageId);
    if (data.conversationType) targetUrl.searchParams.set("conversationType", data.conversationType);
  }
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client) await client.navigate(targetUrl.href);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(targetUrl.href);
  })());
});

const CACHE = "connectchat-shell-v3";
const FILES = ["./", "./index.html", "./styles.css", "./manifest.webmanifest"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
