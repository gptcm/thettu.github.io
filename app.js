import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { initializeApp as initializeFirebaseApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import { getMessaging, getToken, deleteToken, onMessage } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging.js";

/* Add your project's public URL and anon key from Supabase -> Project Settings -> API.
   Never put a service_role key in browser code. */
const SUPABASE_URL = "https://pjwbrtywmfcphlhyfllg.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_tX6HSw1UcWxklsgiV59yig_1LHL11Yx";
// Firebase Console -> Project settings -> General -> Your apps -> Web app.
// Paste the Web app config and Cloud Messaging Web Push certificate public VAPID key here.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDgafD-CDcaiam_Efh9kJZuEBSZ0kUM9Jw",
  authDomain: "connectchat-6309c.firebaseapp.com",
  projectId: "connectchat-6309c",
  storageBucket: "connectchat-6309c.firebasestorage.app",
  messagingSenderId: "983109078249",
  appId: "1:983109078249:web:aff21aa205b8a4c8b6b478"
};
const FIREBASE_VAPID_KEY = "BCs3gR1VI6WRNKZmNasi87pqDBgvZ5KJJ5LqaFH1kkR58dt5RdrlfIcupjdhr7EhhqhOiQpf1TNE60QdpevFN5U";
let firebaseMessaging = null, fcmServiceWorkerRegistration = null;

const $ = (id) => document.getElementById(id);

function returnToChatList() {
  $("appView").classList.remove("chat-open");
  $("dmView").classList.add("hidden");
  $("roomView").classList.add("hidden");
  $("emptyState").classList.remove("hidden");
  activeFriend = null; activeRoom = null;
  closeRoomSubscription();
  endCall(false);
}
document.querySelectorAll(".chat-back-btn").forEach(button => button.addEventListener("click", returnToChatList));
const authView = $("authView"), appView = $("appView");
let supabase, user, activeRoom = null, messageChannel = null, activeFriend = null, directMessageChannel = null, readStateChannel = null;
let callChannel = null, peer = null, localStream = null, callMode = "audio";
let muted = false, cameraOff = false, handlingOffer = false;
let callPeerId = null, pendingIncomingCall = null, queuedIce = [], videoExpanded = false;
let activeCallLogId = null, activeCallAccepted = false, ringTimeout = null;
let noiseCancellationEnabled = true, hdVideoEnabled = true;
let callCameraFacing = "user";
const unreadCounts = { dm: new Map(), room: new Map() };
const notifiedMessageIds = new Set();
const readStates = { dm: new Map(), room: new Map() };
const lastReadWriteAt = new Map();
const readKey = (kind, id) => `connectchat-read-${user?.id || "guest"}-${kind}-${id}`;
function readTimestamp(kind, id) {
  return readStates[kind].get(id) || localStorage.getItem(readKey(kind, id)) || "1970-01-01T00:00:00.000Z";
}
async function saveConversationRead(kind, id, timestamp) {
  if (!supabase || !user || !id) return;
  const payload = { user_id: user.id, conversation_type: kind, conversation_id: id, last_read_at: timestamp };
  const { error } = await supabase.from("conversation_reads").upsert(payload, { onConflict: "user_id,conversation_type,conversation_id" });
  if (error) console.warn("Could not sync read status:", error.message);
}
function markConversationRead(kind, id) {
  if (!user || !id) return;
  const timestamp = new Date().toISOString();
  readStates[kind].set(id, timestamp);
  localStorage.setItem(readKey(kind, id), timestamp);
  unreadCounts[kind].set(id, 0);
  updateUnreadBadges();
  const writeKey = `${kind}:${id}`;
  const now = Date.now();
  if (now - (lastReadWriteAt.get(writeKey) || 0) > 1200) {
    lastReadWriteAt.set(writeKey, now);
    saveConversationRead(kind, id, timestamp).catch(console.error);
  }
}
async function loadReadStates() {
  if (!supabase || !user) return;
  const { data, error } = await supabase.from("conversation_reads").select("conversation_type,conversation_id,last_read_at").eq("user_id", user.id);
  if (error) { status(`Read-sync setup needed: run unread-sync-migration.sql (${error.message})`); return; }
  for (const kind of ["dm", "room"]) readStates[kind].clear();
  (data || []).forEach(row => {
    if (readStates[row.conversation_type]) readStates[row.conversation_type].set(row.conversation_id, row.last_read_at);
  });
  // Keep the existing browser's read position when upgrading; otherwise start at login time.
  const friendIds = [...document.querySelectorAll(".person-row[data-chat-id]")].map(row => row.dataset.chatId);
  const roomIds = [...document.querySelectorAll(".room-item[data-room-id]")].map(row => row.dataset.roomId);
  const missing = [];
  for (const [kind, ids] of [["dm", friendIds], ["room", roomIds]]) {
    for (const id of ids) {
      if (!readStates[kind].has(id)) {
        const seed = localStorage.getItem(readKey(kind, id)) || new Date().toISOString();
        readStates[kind].set(id, seed);
        missing.push({ user_id: user.id, conversation_type: kind, conversation_id: id, last_read_at: seed });
      }
    }
  }
  if (missing.length) {
    const { error: seedError } = await supabase.from("conversation_reads").upsert(missing, { onConflict: "user_id,conversation_type,conversation_id" });
    if (seedError) console.warn("Could not initialize read states:", seedError.message);
  }
  subscribeReadStates();
}
function subscribeReadStates() {
  if (!supabase || !user) return;
  if (readStateChannel) supabase.removeChannel(readStateChannel);
  readStateChannel = supabase.channel(`read-states-${user.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "conversation_reads", filter: `user_id=eq.${user.id}` }, payload => {
      const row = payload.new;
      if (!row || !readStates[row.conversation_type]) return;
      const current = readStates[row.conversation_type].get(row.conversation_id);
      const newest = !current || Date.parse(row.last_read_at) > Date.parse(current) ? row.last_read_at : current;
      readStates[row.conversation_type].set(row.conversation_id, newest);
      localStorage.setItem(readKey(row.conversation_type, row.conversation_id), newest);
      refreshUnreadCounts().catch(() => {});
    }).subscribe();
}
const notificationPreferenceKey = () => `connectchat-notifications-${user?.id || "guest"}`;
function notificationsEnabled() {
  return !!user && localStorage.getItem(notificationPreferenceKey()) === "on";
}
const notificationSoundKey = () => `connectchat-notification-sound-${user?.id || "guest"}`;
function selectedNotificationSound() {
  return localStorage.getItem(notificationSoundKey()) || "classic";
}
function playNotificationSound() {
  const sound = selectedNotificationSound();
  if (sound === "none") return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const patterns = {
      classic: [[660, 0], [880, 0.13]],
      chime: [[523, 0], [659, 0.16], [784, 0.32]],
      bell: [[880, 0]],
      digital: [[740, 0], [740, 0.10], [988, 0.24]]
    };
    (patterns[sound] || patterns.classic).forEach(([frequency, delay]) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = sound === "bell" ? "sine" : "triangle";
      osc.frequency.value = frequency; gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.24);
      osc.connect(gain); gain.connect(ctx.destination); osc.start(ctx.currentTime + delay); osc.stop(ctx.currentTime + delay + 0.26);
    });
    setTimeout(() => ctx.close().catch(()=>{}), 1200);
  } catch (error) { console.debug("Notification sound unavailable until the user interacts with the page:", error); }
}
function firebaseConfigured() {
  return !Object.values(FIREBASE_CONFIG).some(value => String(value).includes("YOUR_")) &&
    !FIREBASE_VAPID_KEY.includes("YOUR_") && FIREBASE_VAPID_KEY.length > 20;
}
async function initFirebaseMessaging() {
  if (!firebaseConfigured()) throw new Error("Add your Firebase Web App config and VAPID public key in app.js first.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support web push notifications.");
  if (!firebaseMessaging) {
    const firebaseApp = initializeFirebaseApp(FIREBASE_CONFIG, "connectchat-fcm");
    firebaseMessaging = getMessaging(firebaseApp);
    onMessage(firebaseMessaging, payload => {
      if (!notificationsEnabled()) return;
      const title = payload.data?.title || payload.notification?.title || "ConnectChat";
      const body = payload.data?.body || payload.notification?.body || "You have a new message.";
      playNotificationSound();
      if (document.visibilityState !== "visible") showChatNotification(title, body, payload.data?.messageId || Date.now());
    });
  }
  fcmServiceWorkerRegistration = await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;
  return firebaseMessaging;
}
function refreshNotificationSettings() {
  const toggle = $("notificationToggle");
  const label = $("notificationStatus");
  if (!toggle || !label) return;
  const supported = "Notification" in window && "serviceWorker" in navigator;
  toggle.disabled = !supported || !user;
  toggle.checked = supported && notificationsEnabled() && Notification.permission === "granted";
  label.textContent = !supported
    ? "This browser does not support web push notifications."
    : Notification.permission === "denied"
      ? "Blocked by your browser. Allow notifications in site settings to turn this on."
      : !firebaseConfigured()
        ? "Add Firebase Web config and VAPID key to enable push notifications."
        : toggle.checked ? "Push notifications are on for this device." : "Push notifications are off for this device.";
}
async function setNotificationsEnabled(enabled) {
  if (!user) return;
  if (!enabled) {
    localStorage.setItem(notificationPreferenceKey(), "off");
    try {
      if (firebaseConfigured() && Notification.permission === "granted") {
        await initFirebaseMessaging();
        const token = await getToken(firebaseMessaging, { vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: fcmServiceWorkerRegistration });
        if (token) {
          const { error } = await supabase.from("device_tokens").delete().eq("user_id", user.id).eq("fcm_token", token);
          if (error) throw error;
        }
        await deleteToken(firebaseMessaging);
      }
    } catch (error) {
      console.warn("Could not fully unregister FCM token:", error);
      refreshNotificationSettings();
      status("Notifications are off in this browser, but the server token could not be removed. Check the device_tokens migration and try again.");
      return;
    }
    refreshNotificationSettings();
    status("Push notifications turned off on this device.");
    return;
  }
  if (!("Notification" in window)) return status("This browser does not support notifications.");
  if (Notification.permission === "denied") { refreshNotificationSettings(); return status("Notifications are blocked. Allow them in browser site settings, then try again."); }
  if (!firebaseConfigured()) { refreshNotificationSettings(); return status("Configure Firebase Web app settings and VAPID key in app.js first."); }
  try {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    await initFirebaseMessaging();
    const token = await getToken(firebaseMessaging, { vapidKey: FIREBASE_VAPID_KEY, serviceWorkerRegistration: fcmServiceWorkerRegistration });
    if (!token) throw new Error("Firebase did not return a device token. Check the VAPID key and service worker.");
    const { error } = await supabase.from("device_tokens").upsert({ user_id: user.id, fcm_token: token, updated_at: new Date().toISOString() }, { onConflict: "fcm_token" });
    if (error) throw new Error(`Could not save this device token: ${error.message}. Run fcm-device-tokens.sql in Supabase.`);
    localStorage.setItem(notificationPreferenceKey(), "on");
    status("Push notifications enabled on this device.");
  } catch (error) {
    localStorage.setItem(notificationPreferenceKey(), "off");
    status(error.message || "Could not enable push notifications.");
  }
  refreshNotificationSettings();
}
function showChatNotification(title, body, tag) {
  if (!notificationsEnabled() || document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
  try { const n = new Notification(title, { body: body || "New message", tag: `connectchat-${tag}` }); n.onclick = () => { window.focus(); n.close(); }; } catch (_) {}
}
async function sendPushNotification(messageId, conversationType) {
  if (!supabase || !user || !messageId) return;
  const { error } = await supabase.functions.invoke("send-chat-push", { body: { messageId, conversationType } });
  if (error) console.warn("Push notification dispatch failed:", error.message);
}
function updateUnreadBadges() {
  const total = [...unreadCounts.dm.values(), ...unreadCounts.room.values()].reduce((a,b)=>a+b,0);
  const totalNode = $("unreadTotalBadge"); if (totalNode) totalNode.textContent = String(total);
  document.querySelectorAll(".person-row[data-chat-id]").forEach(row => {
    const count = unreadCounts.dm.get(row.dataset.chatId) || 0;
    row.classList.toggle("has-unread", count > 0);
    let badge = row.querySelector(".unread-badge");
    if (count > 0) { if (!badge) { badge=document.createElement("span"); badge.className="unread-badge"; row.append(badge); } badge.textContent=count>99?"99+":String(count); }
    else badge?.remove();
    const unreadFilter = document.querySelector('.filter-chip[data-filter="unread"]')?.classList.contains("active");
    if (unreadFilter && !document.querySelector('.filter-chip[data-filter="groups"]')?.classList.contains("active")) row.hidden = count===0;
  });
  document.querySelectorAll(".room-item[data-room-id]").forEach(row => {
    const count = unreadCounts.room.get(row.dataset.roomId) || 0;
    row.classList.toggle("has-unread", count > 0);
    let badge = row.querySelector(".unread-badge");
    if (count > 0) { if (!badge) { badge=document.createElement("span"); badge.className="unread-badge"; row.append(badge); } badge.textContent=count>99?"99+":String(count); }
    else badge?.remove();
    const unreadFilter = document.querySelector('.filter-chip[data-filter="unread"]')?.classList.contains("active");
    const groupsFilter = document.querySelector('.filter-chip[data-filter="groups"]')?.classList.contains("active");
    if (unreadFilter && groupsFilter) row.hidden = count===0;
  });
}
async function refreshUnreadCounts() {
  if (!supabase || !user) return;
  const friendRows = await supabase.from("friend_requests").select("sender_id,receiver_id").eq("status","accepted").or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
  const friendIds = [...new Set((friendRows.data||[]).map(r=>r.sender_id===user.id?r.receiver_id:r.sender_id))];
  const roomRows = await supabase.from("rooms").select("id,room_members!inner(user_id)").eq("room_members.user_id",user.id);
  const roomIds = (roomRows.data||[]).map(r=>r.id);
  const checks = await Promise.all([
    ...friendIds.map(async id => { const {count,error}=await supabase.from("direct_messages").select("id",{count:"exact",head:true}).eq("sender_id",id).eq("receiver_id",user.id).gt("created_at",readTimestamp("dm",id)); if(!error) { const previous=unreadCounts.dm.get(id); unreadCounts.dm.set(id,count||0); if(previous!==undefined && (count||0)>previous) { const latest=await supabase.from("direct_messages").select("id,body").eq("sender_id",id).eq("receiver_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle(); if(latest.data && !notifiedMessageIds.has(latest.data.id)) { notifiedMessageIds.add(latest.data.id); showChatNotification("New private message",latest.data.body||"You received a message",latest.data.id); } } } }),
    ...roomIds.map(async id => { const {count,error}=await supabase.from("messages").select("id",{count:"exact",head:true}).eq("room_id",id).neq("sender_id",user.id).gt("created_at",readTimestamp("room",id)); if(!error) { const previous=unreadCounts.room.get(id); unreadCounts.room.set(id,count||0); if(previous!==undefined && (count||0)>previous) { const latest=await supabase.from("messages").select("id,body").eq("room_id",id).neq("sender_id",user.id).order("created_at",{ascending:false}).limit(1).maybeSingle(); if(latest.data && !notifiedMessageIds.has(latest.data.id)) { notifiedMessageIds.add(latest.data.id); showChatNotification("New group message",latest.data.body||"New message in a group",latest.data.id); } } } })
  ]);
  updateUnreadBadges();
}
document.querySelectorAll(".filter-chip[data-filter]").forEach(chip => chip.addEventListener("click", () => setTimeout(updateUnreadBadges, 0)));

const soundSelect = $("notificationSoundSelect");
if (soundSelect) {
  soundSelect.value = selectedNotificationSound();
  soundSelect.addEventListener("change", () => localStorage.setItem(notificationSoundKey(), soundSelect.value));
}
$("testNotificationSoundBtn")?.addEventListener("click", () => {
  if (soundSelect?.value === "none") { status("Notification sound is set to Silent."); return; }
  playNotificationSound();
  status("Playing your selected notification sound.");
});

$("notificationToggle")?.addEventListener("change", async (event) => {
  await setNotificationsEnabled(event.currentTarget.checked);
});

// The header bell opens notification preferences; the Settings switch is the source of truth.
$("enableNotificationsBtn")?.addEventListener("click", () => {
  $("settingsPanel").classList.remove("hidden");
  refreshNotificationSettings();
  $("notificationToggle")?.focus();
});

function status(message, auth=false) {
  (auth ? $("authStatus") : $("appStatus")).textContent = message || "";
}
function configured() {
  return SUPABASE_URL.startsWith("https://") && !SUPABASE_ANON_KEY.startsWith("YOUR_");
}
function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function shortId(id) { return id === user.id ? "You" : `User ${id.slice(0,6)}`; }

async function boot() {
  if (!configured()) {
    status("Setup required: add your Supabase URL and anon key in app.js, then reload.", true);
    return;
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { session } } = await supabase.auth.getSession();
  if (session) await enterApp(session.user);
  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session && !user) await enterApp(session.user);
    if (!session && user) leaveApp();
  });
}
$("authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!configured()) return status("Configure Supabase first (see README).", true);
  status("Logging in…", true);
  const { data, error } = await supabase.auth.signInWithPassword({
    email: $("email").value.trim(), password: $("password").value
  });
  if (error) status(error.message, true);
  else await enterApp(data.user);
});
$("signupBtn").addEventListener("click", async () => {
  if (!configured()) return status("Configure Supabase first (see README).", true);
  status("Creating account…", true);
  const { data, error } = await supabase.auth.signUp({
    email: $("email").value.trim(), password: $("password").value
  });
  if (error) status(error.message, true);
  else if (!data.session) status("Account created. Check your email to confirm, then log in.", true);
  else await enterApp(data.user);
});
$("logoutBtn").addEventListener("click", async () => { await supabase.auth.signOut(); });
$("settingsBtn").addEventListener("click", () => { $("settingsPanel").classList.remove("hidden"); refreshNotificationSettings(); });
$("closeSettingsBtn").addEventListener("click", () => $("settingsPanel").classList.add("hidden"));
function leaveApp() {
  user = null; activeRoom = null; activeFriend = null; authView.classList.remove("hidden"); appView.classList.add("hidden");
  closeRoomSubscription();
  if (directMessageChannel && supabase) supabase.removeChannel(directMessageChannel);
  if (readStateChannel && supabase) supabase.removeChannel(readStateChannel);
  directMessageChannel = null; readStateChannel = null;
  endCall(false);
}
async function enterApp(currentUser) {
  if (user?.id === currentUser.id && !appView.classList.contains("hidden")) return;
  user = currentUser;
  authView.classList.add("hidden"); appView.classList.remove("hidden");
  $("userLabel").textContent = user.email || "No email available";
  refreshNotificationSettings();
  await Promise.all([loadRooms(), loadMyProfile(), loadFriendRequests(), loadFriends()]);
  await loadReadStates();
  await refreshUnreadCounts();
  subscribeDirectMessages(); renderCallHistory();
}
async function loadMyProfile() {
  const {data, error} = await supabase.from("profiles").select("username,display_name,avatar_url").eq("id", user.id).maybeSingle();
  if (error) return status(error.message);
  if (!data) return status("Your profile is not ready. Run friends.sql in Supabase SQL Editor.");
  $("usernameInput").value = data.username || "";
  $("displayNameInput").value = data.display_name || "";
  setAvatarPreview(data.avatar_url || "");
  $("myHandle").textContent = `Your username: @${data.username}`;
}
$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("usernameInput").value.trim().toLowerCase();
  const display_name = $("displayNameInput").value.trim();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return status("Username must be 3–24 characters: letters, numbers or underscore.");
  if (!display_name) return status("Please enter a display name.");
  let avatar_url;
  const file = $("avatarInput").files?.[0];
  if (file) {
    if (!file.type.startsWith("image/")) return status("Choose an image file for your profile picture.");
    if (file.size > 5 * 1024 * 1024) return status("Profile pictures must be 5 MB or smaller.");
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const path = `${user.id}/${Date.now()}.${ext}`;
    const upload = await supabase.storage.from("profile-avatars").upload(path, file, {upsert:true, contentType:file.type, cacheControl:"3600"});
    if (upload.error) return status(`Could not upload picture: ${upload.error.message}. Check the profile-avatars storage bucket setup in friends.sql.`);
    avatar_url = supabase.storage.from("profile-avatars").getPublicUrl(path).data.publicUrl;
  }
  const changes = {username, display_name};
  if (avatar_url) changes.avatar_url = avatar_url;
  const {error} = await supabase.from("profiles").update(changes).eq("id", user.id);
  if (error) return status(error.message);
  if (avatar_url) { setAvatarPreview(avatar_url); $("avatarInput").value = ""; }
  $("myHandle").textContent = `Your username: @${username}`;
  status("Profile saved.");
});
function setAvatarPreview(url) {
  const img = $("profileAvatarPreview");
  if (!img) return;
  if (url) { img.src = url; img.hidden = false; }
  else { img.removeAttribute("src"); img.hidden = true; }
}
$("avatarInput")?.addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
    status("Choose an image up to 5 MB."); event.target.value = ""; return;
  }
  setAvatarPreview(URL.createObjectURL(file));
});
function personRow(profile, actionLabel, action, subtitle) {
  const row = document.createElement("div"); row.className = "person-row";
  const avatar = document.createElement("img"); avatar.className = "person-avatar";
  avatar.alt = ""; avatar.loading = "lazy";
  if (profile.avatar_url) avatar.src = profile.avatar_url;
  else { avatar.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><rect width="80" height="80" rx="40" fill="#29443f"/><text x="40" y="51" text-anchor="middle" font-size="34" fill="#d9f5ec" font-family="Arial">${(profile.display_name || profile.username || "?").trim().charAt(0).toUpperCase()}</text></svg>`)}`; }
  const info = document.createElement("div"); info.className = "person-name";
  const name = document.createElement("strong"); name.textContent = profile.display_name || profile.username;
  const sub = document.createElement("small"); sub.textContent = subtitle || `@${profile.username}`;
  info.append(name, sub); row.append(avatar, info);
  if (actionLabel) {
    const button = document.createElement("button"); button.className = "secondary"; button.textContent = actionLabel;
    button.addEventListener("click", action); row.append(button);
  }
  return row;
}

function showEmptyPeople(target, message) {
  $(target).innerHTML = ""; const p = document.createElement("p"); p.className = "person-empty"; p.textContent = message; $(target).append(p);
}
$("friendSearchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const term = $("friendSearchInput").value.trim().replace(/^@/, "");
  if (term.length < 2) return status("Enter at least 2 characters to search.");
  const byUsername = await supabase.from("profiles").select("id,username,display_name,avatar_url").ilike("username", `%${term}%`).neq("id", user.id).limit(10);
  if (byUsername.error) return status(byUsername.error.message);
  const byName = await supabase.from("profiles").select("id,username,display_name,avatar_url").ilike("display_name", `%${term}%`).neq("id", user.id).limit(10);
  if (byName.error) return status(byName.error.message);
  const matches = [...new Map([...(byUsername.data||[]), ...(byName.data||[])].map(p=>[p.id,p])).values()].slice(0,10);
  const target = $("friendSearchResults"); target.innerHTML = "";
  if (!matches.length) return showEmptyPeople("friendSearchResults", "No users found.");
  matches.forEach(profile => target.append(personRow(profile, "Add", async () => {
    const {error} = await supabase.rpc("send_friend_request", {p_username:profile.username});
    if (error) status(error.message); else { status(`Friend request sent to @${profile.username}.`); }
    await loadFriendRequests();
  }, `@${profile.username}`)));
});
async function loadFriendRequests() {
  const {data, error} = await supabase.from("friend_requests").select("id,sender_id,created_at").eq("receiver_id", user.id).eq("status", "pending").order("created_at", {ascending:false});
  if (error) return status(error.message);
  const list = $("requestList"); list.innerHTML = "";
  if (!data?.length) return showEmptyPeople("requestList", "No new requests.");
  const ids = data.map(r=>r.sender_id);
  const profiles = await supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", ids);
  if (profiles.error) return status(profiles.error.message);
  const byId = new Map((profiles.data||[]).map(p=>[p.id,p]));
  data.forEach(request => {
    const profile = byId.get(request.sender_id); if (!profile) return;
    const row = personRow(profile, "Accept", async () => {
      const {error} = await supabase.rpc("respond_friend_request", {p_request_id:request.id,p_accept:true});
      if (error) status(error.message); else status(`You are now friends with @${profile.username}.`);
      await loadFriendRequests(); await loadFriends();
    }, `@${profile.username}`);
    const decline = document.createElement("button"); decline.className="quiet"; decline.textContent="×";
    decline.title="Decline request"; decline.addEventListener("click", async()=>{
      const {error}=await supabase.rpc("respond_friend_request",{p_request_id:request.id,p_accept:false});
      if(error) status(error.message); await loadFriendRequests();
    }); row.append(decline); list.append(row);
  });
}
async function loadFriends() {
  const {data, error} = await supabase.from("friend_requests").select("sender_id,receiver_id").eq("status", "accepted").or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`);
  if (error) return status(error.message);
  const ids = [...new Set((data||[]).map(r=>r.sender_id===user.id?r.receiver_id:r.sender_id))];
  const list = $("friendList"); list.innerHTML = "";
  if (!ids.length) return showEmptyPeople("friendList", "No friends yet. Search by username above.");
  const profiles = await supabase.from("profiles").select("id,username,display_name,avatar_url").in("id", ids);
  if (profiles.error) return status(profiles.error.message);
  profiles.data.forEach(profile => {
    const row = personRow(profile, "Chat", ()=>openDirectChat(profile), `@${profile.username}`);
    row.dataset.chatId = profile.id;
    list.append(row);
  });
  updateUnreadBadges();
}
function subscribeDirectMessages() {
  if (directMessageChannel) supabase.removeChannel(directMessageChannel);
  directMessageChannel = supabase.channel(`private-messages-${user.id}`)
    .on("postgres_changes", {event:"INSERT",schema:"public",table:"direct_messages"}, payload => {
      const m = payload.new;
      if (m.receiver_id===user.id && m.sender_id!==user.id && (!activeFriend || activeFriend.id!==m.sender_id)) { notifiedMessageIds.add(m.id); playNotificationSound(); showChatNotification("New private message", m.body || "You received a message", m.id); }
      refreshUnreadCounts().catch(()=>{});
      if (activeFriend && ((m.sender_id===user.id && m.receiver_id===activeFriend.id) || (m.sender_id===activeFriend.id && m.receiver_id===user.id))) renderDirectMessage(m);
    }).subscribe();
}
async function openDirectChat(friend) {
  $("appView").classList.add("chat-open");
  activeFriend = friend; activeRoom = null;
  markConversationRead("dm", friend.id);
  closeRoomSubscription(); endCall(false);
  ensureCallChannel(friend.id).catch(err=>status(err.message));
  $("emptyState").classList.add("hidden"); $("roomView").classList.add("hidden"); $("dmView").classList.remove("hidden");
  $("dmTitle").textContent = friend.display_name || friend.username;
  $("dmSub").textContent = "online";
  $("dmMessages").innerHTML = '<p class="tiny muted">Loading messages…</p>';
  const pairFilter = `and(sender_id.eq.${user.id},receiver_id.eq.${friend.id}),and(sender_id.eq.${friend.id},receiver_id.eq.${user.id})`;
  const {data,error} = await supabase.from("direct_messages").select("*").or(pairFilter).order("created_at",{ascending:true}).limit(300);
  if (error) { status(error.message); return; }
  $("dmMessages").innerHTML = "";
  (data||[]).filter(m => !(m.deleted_for||[]).includes(user.id)).forEach(renderDirectMessage); scrollDirectMessages();
}
function renderDirectMessage(m) {
  directMessageCache.set(m.id,m);
  if (activeFriend && (m.sender_id===activeFriend.id || m.receiver_id===activeFriend.id)) markConversationRead("dm", activeFriend.id);
  if ((m.deleted_for||[]).includes(user.id)) return;
  if (document.querySelector(`[data-dm-id="${m.id}"]`)) return;
  const node = document.createElement("article"); node.className = "message" + (m.sender_id===user.id?" mine":""); node.dataset.dmId=m.id;
  const time = new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  const meta = document.createElement("div"); meta.className="meta"; meta.textContent=time;
  const body = document.createElement("div"); body.className="body";
  if (m.message_type === "voice" && m.media_url) {
    const label = document.createElement("div"); label.className = "voice-message-label"; label.textContent = "🎤 Voice message";
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = m.media_url; body.append(label, audio);
  } else if (m.message_type === "image" && m.media_url) { const img=document.createElement("img"); img.className="chat-attachment-image"; img.src=m.media_url; img.alt=m.file_name||"Shared image"; img.loading="lazy"; body.append(img); }
  else if (m.message_type === "video" && m.media_url) { const video=document.createElement("video"); video.className="chat-attachment-video"; video.src=m.media_url; video.controls=true; video.preload="metadata"; body.append(video); }
  else if (m.message_type === "file" && m.media_url) { const a=document.createElement("a"); a.className="chat-file-link"; a.href=m.media_url; a.target="_blank"; a.rel="noopener"; a.textContent="📎 "+(m.file_name||"Download file"); body.append(a); }
  else body.textContent=m.body;
  node.append(meta,body); $("dmMessages").append(node); scrollDirectMessages();
}
function scrollDirectMessages(){ $("dmMessages").scrollTop=$("dmMessages").scrollHeight; }
$("dmMessageForm").addEventListener("submit", async (e)=>{
  e.preventDefault(); const body=$("dmMessageInput").value.trim();
  if(!body||!activeFriend) return;
  $("dmMessageInput").value="";
  const {data,error}=await supabase.from("direct_messages").insert({sender_id:user.id,receiver_id:activeFriend.id,body,message_type:"text"}).select("id").single();
  if(error){$("dmMessageInput").value=body;status(error.message);} else sendPushNotification(data.id, "direct");
});


// Long-press a message to select it. Selected messages can be hidden locally
// or recalled for everyone when sent by the current user.
const selectedMessages = new Map();
let holdTimer = null, holdTarget = null, holdTriggered = false;
function selectionToolbar() {
  let bar = $("messageSelectionBar");
  if (!bar) {
    bar = document.createElement("div"); bar.id = "messageSelectionBar"; bar.className = "message-selection-bar hidden";
    bar.innerHTML = '<span id="selectedMessageCount">0 selected</span><button id="deleteForMeBtn" type="button">Delete for me</button><button id="deleteEveryoneBtn" type="button">Delete for everyone</button><button id="cancelSelectionBtn" type="button" aria-label="Cancel selection">Cancel</button>';
    document.body.appendChild(bar);
    $("deleteForMeBtn").addEventListener("click", () => deleteSelectedMessages("me"));
    $("deleteEveryoneBtn").addEventListener("click", () => deleteSelectedMessages("everyone"));
    $("cancelSelectionBtn").addEventListener("click", clearMessageSelection);
  }
  return bar;
}
function updateSelectionUI() {
  const bar=selectionToolbar(), count=selectedMessages.size;
  bar.classList.toggle("hidden", !count);
  $("selectedMessageCount").textContent=`${count} selected`;
  const canDeleteEveryone=[...selectedMessages.values()].every(x=>x.sender_id===user.id);
  $("deleteEveryoneBtn").classList.toggle("hidden", !canDeleteEveryone);
  document.querySelectorAll(".message").forEach(n=>n.classList.toggle("message-selected", selectedMessages.has(n.dataset.dmId||n.dataset.messageId)));
}
function selectMessage(node, kind, message) {
  const id=message.id;
  if (selectedMessages.has(id)) selectedMessages.delete(id);
  else selectedMessages.set(id,{id,kind,sender_id:message.sender_id});
  updateSelectionUI();
}
function clearMessageSelection() {
  selectedMessages.clear(); updateSelectionUI();
}
async function deleteSelectedMessages(mode) {
  const items=[...selectedMessages.values()];
  if (!items.length) return;
  if (mode==="everyone" && items.some(x=>x.sender_id!==user.id)) return status("You can only delete your own messages for everyone.");
  const label=mode==="everyone"?"Delete selected message(s) for everyone?":"Delete selected message(s) for you?";
  if (!window.confirm(label)) return;
  for (const item of items) {
    const rpc= item.kind==="dm"
      ? await supabase.rpc(mode==="everyone"?"delete_direct_message_everyone":"delete_direct_message_for_me",{p_message_id:item.id})
      : await supabase.rpc(mode==="everyone"?"delete_room_message_everyone":"delete_room_message_for_me",{p_message_id:item.id});
    if (rpc.error) { status(rpc.error.message); return; }
  }
  clearMessageSelection();
  if (activeFriend) await openDirectChat(activeFriend);
  else if (activeRoom) await loadMessages();
  status(mode==="everyone"?"Message deleted for everyone.":"Message deleted for you.");
}
function attachMessageHoldSelection(container, kind) {
  if (container.dataset.holdSelectionBound) return;
  container.dataset.holdSelectionBound="1";
  container.addEventListener("pointerdown", e=>{
    const node=e.target.closest(".message"); if(!node) return;
    holdTarget=node; holdTriggered=false;
    const id=node.dataset.dmId||node.dataset.messageId;
    const list=kind==="dm"?directMessageCache:roomMessageCache;
    const msg=list?.get(id);
    if(!msg) return;
    holdTimer=setTimeout(()=>{holdTriggered=true;selectMessage(node,kind,msg);},450);
  });
  const cancel=()=>{clearTimeout(holdTimer);holdTimer=null;};
  container.addEventListener("pointerup",cancel);
  container.addEventListener("pointercancel",cancel);
  container.addEventListener("pointermove",cancel);
  container.addEventListener("click",e=>{
    const node=e.target.closest(".message"); if(!node) return;
    const id=node.dataset.dmId||node.dataset.messageId;
    if(holdTriggered){e.preventDefault();e.stopPropagation();holdTriggered=false;return;}
    if(selectedMessages.size){
      const msg=(kind==="dm"?directMessageCache:roomMessageCache)?.get(id);
      if(msg){e.preventDefault();selectMessage(node,kind,msg);}
    }
  });
}
const directMessageCache=new Map(), roomMessageCache=new Map();
attachMessageHoldSelection($("dmMessages"),"dm");
attachMessageHoldSelection($("messages"),"room");

async function loadRooms() {
  const { data, error } = await supabase.from("rooms")
    .select("id,code,name,created_by,created_at,room_members!inner(user_id)")
    .eq("room_members.user_id", user.id).order("created_at", {ascending:false});
  if (error) return status(error.message);
  const list = $("roomList"); list.innerHTML = "";
  (data || []).forEach(room => {
    const row = document.createElement("div");
    row.className = "group-row";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "room-item" + (activeRoom?.id === room.id ? " active" : "");
    open.dataset.roomId = room.id;
    const label = document.createElement("span"); label.textContent = `▣  ${room.name || "Group"}`;
    const hint = document.createElement("small"); hint.textContent = "Open";
    open.append(label, hint);
    open.addEventListener("click", () => openRoom(room));
    const invite = document.createElement("button");
    invite.type = "button"; invite.className = "group-invite-btn"; invite.textContent = "Invite";
    invite.title = `Copy invite code for group ${room.code}`;
    invite.addEventListener("click", async event => { event.stopPropagation(); await copyRoomInvite(room); });
    row.append(open, invite); list.appendChild(row);
  });
  if (!data?.length) list.innerHTML = '<p class="tiny muted group-empty">No groups yet. Create a group or join with an invite code.</p>';
}
$("newRoomBtn").addEventListener("click", async () => {
  const name = (window.prompt("Enter a name for your group:", "My group") || "").trim();
  if (!name) return;
  if (name.length > 40) return status("Group names must be 40 characters or fewer.");
  const code = makeCode();
  const { data, error } = await supabase.rpc("create_room", {p_code: code, p_name: name});
  if (error) return status(error.message);
  const newRoom = {id:data, code, name, created_by:user.id};
  await loadRooms();
  await openRoom(newRoom);
  status(`“${name}” created. Invite code: ${code}`);
});
$("joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("roomCodeInput").value.trim().toUpperCase();
  if (!code) return;
  const { data, error } = await supabase.rpc("join_room", {p_code:code});
  if (error) return status(error.message);
  $("roomCodeInput").value = "";
  await loadRooms();
  await openRoom(data);
  status(`Joined room ${code}.`);
});
async function openRoom(room) {
  $("appView").classList.add("chat-open");
  closeRoomSubscription();
  activeRoom = room; activeFriend = null;
  markConversationRead("room", room.id);
  $("emptyState").classList.add("hidden"); $("dmView").classList.add("hidden"); $("roomView").classList.remove("hidden");
  $("roomTitle").textContent = room.name || "Group";
  $("roomSub").textContent = `Invite code: ${room.code}`;
  const editNameBtn = $("editRoomNameBtn");
  editNameBtn.classList.toggle("hidden", room.created_by !== user.id);
  editNameBtn.onclick = async () => {
    const nextName = (window.prompt("Edit group name:", room.name || "Group") || "").trim();
    if (!nextName || nextName === (room.name || "Group")) return;
    if (nextName.length > 40) return status("Group names must be 40 characters or fewer.");
    const {error} = await supabase.from("rooms").update({name:nextName}).eq("id", room.id).eq("created_by", user.id);
    if (error) return status(error.message);
    room.name = nextName;
    $("roomTitle").textContent = nextName;
    await loadRooms();
    status("Group name updated.");
  };
  $("messages").innerHTML = '<p class="tiny muted">Loading messages…</p>';
  await loadMessages();
  messageChannel = supabase.channel(`messages-${room.id}`)
    .on("postgres_changes", {event:"INSERT", schema:"public", table:"messages", filter:`room_id=eq.${room.id}`}, payload => { const m=payload.new; if(m.sender_id!==user.id && activeRoom?.id!==m.room_id) showChatNotification("New group message", m.body || "New message in a group", m.id); renderMessage(m); refreshUnreadCounts().catch(()=>{}); })
    .subscribe();
  try { await ensureCallChannel(); } catch (err) { status(err.message); }
  await loadRooms();
}
function closeRoomSubscription() {
  if (messageChannel && supabase) supabase.removeChannel(messageChannel);
  if (callChannel && supabase) supabase.removeChannel(callChannel);
  messageChannel = null;
  callChannel = null;
}
async function loadMessages() {
  const {data,error} = await supabase.from("messages").select("*").eq("room_id",activeRoom.id).order("created_at",{ascending:true}).limit(200);
  if (error) return status(error.message);
  $("messages").innerHTML = "";
  (data || []).filter(m => !(m.deleted_for||[]).includes(user.id)).forEach(renderMessage);
  scrollMessages();
}
function renderMessage(m) {
  roomMessageCache.set(m.id,m);
  if (activeRoom?.id===m.room_id) markConversationRead("room", activeRoom.id);
  if ((m.deleted_for||[]).includes(user.id)) return;
  if (document.querySelector(`[data-message-id="${m.id}"]`)) return;
  const node = document.createElement("article");
  node.className = "message" + (m.sender_id === user.id ? " mine" : "");
  node.dataset.messageId = m.id;
  const time = new Date(m.created_at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  const body = document.createElement("div"); body.className = "body";
  if (m.message_type === "voice" && m.media_url) {
    const label = document.createElement("div"); label.className = "voice-message-label"; label.textContent = "🎤 Voice message";
    const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = m.media_url; body.append(label, audio);
  } else if (m.message_type === "image" && m.media_url) { const img=document.createElement("img"); img.className="chat-attachment-image"; img.src=m.media_url; img.alt=m.file_name||"Shared image"; img.loading="lazy"; body.append(img); }
  else if (m.message_type === "video" && m.media_url) { const video=document.createElement("video"); video.className="chat-attachment-video"; video.src=m.media_url; video.controls=true; video.preload="metadata"; body.append(video); }
  else if (m.message_type === "file" && m.media_url) { const a=document.createElement("a"); a.className="chat-file-link"; a.href=m.media_url; a.target="_blank"; a.rel="noopener"; a.textContent="📎 "+(m.file_name||"Download file"); body.append(a); }
  else body.textContent = m.body;
  const meta = document.createElement("div"); meta.className = "meta"; meta.innerHTML = `${time}${m.sender_id === user.id ? ' <span class="read-ticks">✓✓</span>' : ""}`;
  node.append(body,meta); $("messages").appendChild(node); scrollMessages();
}
function scrollMessages() { $("messages").scrollTop = $("messages").scrollHeight; }
$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("messageInput").value.trim();
  if (!body || !activeRoom) return;
  $("messageInput").value = "";
  const {data,error} = await supabase.from("messages").insert({room_id:activeRoom.id,sender_id:user.id,body}).select("id").single();
  if (error) { $("messageInput").value = body; status(error.message); } else sendPushNotification(data.id, "group");
});

// Attach images, videos and documents from the + button at the bottom-left of each chat.
document.querySelectorAll("[data-attach]").forEach(btn => btn.addEventListener("click", () => $(btn.dataset.attach === "dm" ? "dmAttachmentInput" : "roomAttachmentInput").click()));
async function uploadChatAttachment(kind, file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { status("Please choose a file smaller than 50 MB."); return; }
  if (kind === "dm" && !activeFriend) return status("Open a private chat first.");
  if (kind === "room" && !activeRoom) return status("Open a group chat first.");
  const type = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file";
  status(`Uploading ${file.name}…`);
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${user.id}/${Date.now()}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}-${safeName}`;
  const {error:uploadError} = await supabase.storage.from("chat-media").upload(path, file, {contentType:file.type || "application/octet-stream", upsert:false});
  if (uploadError) return status(`Upload failed: ${uploadError.message}`);
  const {data} = supabase.storage.from("chat-media").getPublicUrl(path);
  const payload = {sender_id:user.id, body:file.name, message_type:type, media_url:data.publicUrl, file_name:file.name};
  const result = kind === "dm"
    ? await supabase.from("direct_messages").insert({...payload, receiver_id:activeFriend.id}).select("id").single()
    : await supabase.from("messages").insert({...payload, room_id:activeRoom.id}).select("id").single();
  if (result.error) status(`Could not send attachment: ${result.error.message}`);
  else { sendPushNotification(result.data.id, kind === "dm" ? "direct" : "group"); status(`${type === "image" ? "Image" : type === "video" ? "Video" : "File"} sent.`); }
}
[ ["dmAttachmentInput","dm"], ["roomAttachmentInput","room"] ].forEach(([id,kind]) => $(id).addEventListener("change", async e => {
  const file=e.target.files?.[0]; e.target.value=""; await uploadChatAttachment(kind,file);
}));
// Camera capture: take a photo or record a short video, preview it, then send or discard.
let captureStream=null, captureRecorder=null, captureChunks=[], captureFile=null, captureMode="photo", cameraFacing="environment", capturePreviewUrl=null;
const cameraModal=$("cameraModal"), captureVideo=$("capturePreview"), capturedPreview=$("capturedPreview");
function stopCaptureStream(){ if(captureStream){captureStream.getTracks().forEach(track=>track.stop());captureStream=null;} captureVideo.srcObject=null; }
function clearCapturePreview(){ if(capturePreviewUrl)URL.revokeObjectURL(capturePreviewUrl);capturePreviewUrl=null;capturedPreview.removeAttribute("src");capturedPreview.hidden=true;captureVideo.hidden=false;captureFile=null;$("sendCaptureBtn").disabled=true;$("discardCaptureBtn").disabled=true; }
async function startCaptureCamera(){
  if(!navigator.mediaDevices?.getUserMedia){$("cameraHint").textContent="Camera access requires HTTPS or localhost and a supported browser.";return;}
  try{stopCaptureStream();captureStream=await navigator.mediaDevices.getUserMedia({audio:captureMode==="video",video:{facingMode:{ideal:cameraFacing},width:{ideal:1280},height:{ideal:720}}});captureVideo.srcObject=captureStream;captureVideo.hidden=false;capturedPreview.hidden=true;$("cameraHint").hidden=true;await captureVideo.play();}
  catch(error){$("cameraHint").hidden=false;$("cameraHint").textContent=error.name==="NotAllowedError"?"Camera permission was denied. Allow camera access in your browser settings.":`Could not open camera: ${error.message}`;}
}
function setCaptureMode(mode){captureMode=mode;$("photoModeBtn").classList.toggle("active",mode==="photo");$("videoModeBtn").classList.toggle("active",mode==="video");$("captureBtn").textContent=mode==="photo"?"Take photo":"Start recording";$("captureBtn").classList.remove("recording");clearCapturePreview();startCaptureCamera();}
function showCapturedFile(file){captureFile=file;stopCaptureStream();if(capturePreviewUrl)URL.revokeObjectURL(capturePreviewUrl);capturePreviewUrl=URL.createObjectURL(file);captureVideo.hidden=true;capturedPreview.hidden=false;capturedPreview.src=capturePreviewUrl;$("sendCaptureBtn").disabled=false;$("discardCaptureBtn").disabled=false;$("captureBtn").textContent=captureMode==="photo"?"Retake photo":"Record again";}
async function openCamera(){if(!activeFriend&&!activeRoom){status("Open a private chat or group before using the camera.");return;}cameraModal.classList.remove("hidden");clearCapturePreview();setCaptureMode("photo");}
$("openCameraBtn")?.addEventListener("click",openCamera);
$("closeCameraBtn")?.addEventListener("click",()=>{if(captureRecorder?.state==="recording")captureRecorder.stop();stopCaptureStream();clearCapturePreview();cameraModal.classList.add("hidden");});
$("photoModeBtn")?.addEventListener("click",()=>setCaptureMode("photo"));
$("videoModeBtn")?.addEventListener("click",()=>setCaptureMode("video"));
$("switchCameraBtn")?.addEventListener("click",()=>{cameraFacing=cameraFacing==="environment"?"user":"environment";startCaptureCamera();});
$("captureBtn")?.addEventListener("click",()=>{
  if(captureFile){setCaptureMode(captureMode);return;}
  if(!captureStream)return status("Camera is not ready. Please allow camera access.");
  if(captureMode==="photo"){
    const canvas=document.createElement("canvas");canvas.width=captureVideo.videoWidth||1280;canvas.height=captureVideo.videoHeight||720;canvas.getContext("2d").drawImage(captureVideo,0,0,canvas.width,canvas.height);
    canvas.toBlob(blob=>{if(blob)showCapturedFile(new File([blob],`ConnectChat-photo-${Date.now()}.jpg`,{type:"image/jpeg"}));},"image/jpeg",.92);return;
  }
  if(captureRecorder?.state==="recording"){captureRecorder.stop();$("captureBtn").textContent="Processing video…";return;}
  captureChunks=[];let options={};if(MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus"))options.mimeType="video/webm;codecs=vp9,opus";else if(MediaRecorder.isTypeSupported("video/webm"))options.mimeType="video/webm";
  try{captureRecorder=new MediaRecorder(captureStream,options);captureRecorder.ondataavailable=e=>{if(e.data?.size)captureChunks.push(e.data);};captureRecorder.onstop=()=>{const blob=new Blob(captureChunks,{type:captureRecorder.mimeType||"video/webm"});if(blob.size>50*1024*1024){status("Video is larger than the 50 MB upload limit. Please record a shorter video.");startCaptureCamera();return;}showCapturedFile(new File([blob],`ConnectChat-video-${Date.now()}.webm`,{type:blob.type}));};captureRecorder.start();$("captureBtn").textContent="Stop recording";$("captureBtn").classList.add("recording");}
  catch(error){status(`Could not start video recording: ${error.message}`);}
});
$("discardCaptureBtn")?.addEventListener("click",()=>{if(captureRecorder?.state==="recording")captureRecorder.stop();clearCapturePreview();startCaptureCamera();$("captureBtn").textContent=captureMode==="photo"?"Take photo":"Start recording";});
$("sendCaptureBtn")?.addEventListener("click",async()=>{if(!captureFile)return;const kind=activeFriend?"dm":"room",file=captureFile;$("sendCaptureBtn").disabled=true;await uploadChatAttachment(kind,file);stopCaptureStream();clearCapturePreview();cameraModal.classList.add("hidden");});

async function copyRoomInvite(room) {
  const inviteText = `Join my ConnectChat group with invite code: ${room.code}`;
  try {
    if (navigator.share) await navigator.share({title:"ConnectChat group invite", text:inviteText});
    else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(room.code); status(`Invite code ${room.code} copied. Share it with your friends.`); }
    else status(inviteText);
  } catch (error) {
    if (error?.name !== "AbortError") status(`Share this invite code: ${room.code}`);
  }
}
$("shareBtn").addEventListener("click", async () => {
  if (!activeRoom) return;
  await copyRoomInvite(activeRoom);
});

/* Call history is stored per signed-in account in this browser. */
function callHistoryKey() { return `connectchat-call-history-${user?.id || "guest"}`; }
function readCallHistory() { try { return JSON.parse(localStorage.getItem(callHistoryKey()) || "[]"); } catch { return []; } }
function saveCallHistory(items) { localStorage.setItem(callHistoryKey(), JSON.stringify(items.slice(0,100))); renderCallHistory(); }
function logCall({status:callStatus, mode=callMode, direction="outgoing", peerProfile=activeFriend}={}) {
  const entry={id:crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, peerId:peerProfile?.id || callPeerId || "", name:peerProfile?.display_name || peerProfile?.username || "ConnectChat user", username:peerProfile?.username || "", avatar:peerProfile?.avatar_url || "", mode, direction, status:callStatus, time:new Date().toISOString()};
  const items=readCallHistory(); items.unshift(entry); saveCallHistory(items); return entry.id;
}
function updateCallLog(callStatus) {
  if(!activeCallLogId)return;
  const items=readCallHistory(); const entry=items.find(item=>item.id===activeCallLogId);
  if(entry){entry.status=callStatus;entry.time=new Date().toISOString();saveCallHistory(items);}
}
function renderCallHistory() {
  const list=$("callHistoryList"); if(!list)return;
  const items=readCallHistory(); list.replaceChildren();
  if(!items.length){const empty=document.createElement("p");empty.className="muted call-history-empty";empty.textContent="No calls yet. Voice and video calls will appear here.";list.append(empty);return;}
  for(const item of items){
    const row=document.createElement("article");row.className="call-history-row";
    const avatar=document.createElement("img");avatar.className="call-history-avatar";avatar.alt="";avatar.src=item.avatar || `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="#29443f"/><text x="32" y="42" text-anchor="middle" font-size="28" fill="#e9edef">${(item.name||"?").charAt(0).toUpperCase()}</text></svg>`)}`;
    const info=document.createElement("div");info.className="call-history-info";
    const name=document.createElement("strong");name.textContent=item.name;
    const meta=document.createElement("small");const direction=item.direction==="incoming"?"Incoming":"Outgoing";meta.textContent=`${direction} ${item.mode==="video"?"video":"voice"} · ${item.status}`;
    const time=document.createElement("time");time.dateTime=item.time;time.textContent=new Date(item.time).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
    const icon=document.createElement("span");icon.className=`call-history-type ${item.status==="Missed"||item.status==="Rejected"?"call-history-alert":""}`;icon.textContent=item.mode==="video"?"▣":"☎";
    info.append(name,meta);row.append(avatar,info,time,icon);list.append(row);
  }
}
document.querySelectorAll('.nav-item[data-tab]').forEach(button=>button.addEventListener('click',()=>{
  const tab=button.dataset.tab;
  document.querySelectorAll('.nav-item[data-tab]').forEach(item=>item.classList.toggle('active',item===button));
  const showCalls=tab==="calls"; $("callsView").classList.toggle("hidden",!showCalls);
  $("appView").classList.toggle("calls-open",showCalls);
  if(!showCalls && tab!=="chats") status(`${button.textContent.trim()} is coming soon.`);
  if(showCalls)renderCallHistory();
}));
$("clearCallHistoryBtn").addEventListener("click",()=>{if(confirm("Clear your call history on this device?")){saveCallHistory([]);}});

/* Private friend-to-friend WebRTC calls. */
const rtcConfig = {iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
function sendSignal(signal) {
  if (callChannel && callPeerId) callChannel.send({type:"broadcast",event:"signal",payload:{from:user.id,to:callPeerId,signal}});
}
async function ensureCallChannel(friendId) {
  const ids=[user.id,friendId].sort(), name=`private-call-${ids[0]}-${ids[1]}`;
  if (callChannel && callPeerId===friendId) return;
  if (callChannel) await supabase.removeChannel(callChannel);
  callPeerId=friendId;
  callChannel=supabase.channel(name,{config:{broadcast:{self:false}}});
  callChannel.on("broadcast",{event:"signal"},async ({payload})=>{
    if (!payload || payload.from===user.id || payload.to!==user.id || payload.from!==callPeerId) return;
    const s=payload.signal;
    try {
      if (s.type==="offer") {
        if (peer || pendingIncomingCall) { sendSignal({type:"busy"}); return; }
        pendingIncomingCall={description:s.description,mode:s.mode||"audio"};
        activeCallAccepted=false; activeCallLogId=logCall({status:"Missed",mode:pendingIncomingCall.mode,direction:"incoming",peerProfile:activeFriend});
        $("incomingCallText").textContent=`${s.callerName||"Your friend"} is calling (${pendingIncomingCall.mode==="video"?"video":"voice"})`;
        $("incomingCall").classList.remove("hidden"); $("callPanel").classList.remove("hidden");
        $("callStatus").textContent="Incoming call…";
      } else if (s.type==="answer" && peer) {
        await peer.setRemoteDescription(s.description);
        for (const c of queuedIce.splice(0)) await peer.addIceCandidate(c);
        $("callStatus").textContent="Connected"; activeCallAccepted=true; updateCallLog("Accepted");
      } else if (s.type==="ice" && s.candidate) {
        if (peer?.remoteDescription) await peer.addIceCandidate(s.candidate); else queuedIce.push(s.candidate);
      } else if (s.type==="decline") { status("Your friend declined the call."); updateCallLog("Rejected"); endCall(false); }
      else if (s.type==="busy") { status("Your friend is busy."); updateCallLog("Rejected"); endCall(false); }
      else if (s.type==="hangup") { if(pendingIncomingCall)updateCallLog("Missed"); else if(activeCallAccepted)updateCallLog("Accepted"); status("Call ended by your friend."); endCall(false); }
    } catch(err) { status(`Call error: ${err.message}`); }
  });
  await new Promise((resolve,reject)=>callChannel.subscribe(state=>{
    if(state==="SUBSCRIBED") resolve();
    if(state==="CHANNEL_ERROR"||state==="TIMED_OUT") reject(new Error("Could not connect to private call channel."));
  }));
}
function callMediaConstraints(mode) {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: noiseCancellationEnabled,
      autoGainControl: true
    },
    video: mode === "video" ? {
      width: { ideal: hdVideoEnabled ? 1280 : 640, max: hdVideoEnabled ? 1920 : 1280 },
      height: { ideal: hdVideoEnabled ? 720 : 360, max: hdVideoEnabled ? 1080 : 720 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: { ideal: callCameraFacing }
    } : false
  };
}
async function applyNoiseCancellation() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({
      echoCancellation: true,
      noiseSuppression: noiseCancellationEnabled,
      autoGainControl: true
    });
  } catch (err) {
    status("Your browser does not support changing microphone noise cancellation during a call.");
  }
}
async function applyVideoQuality() {
  if (!localStream || callMode !== "video") return;
  const track = localStream.getVideoTracks()[0];
  if (!track?.applyConstraints) return;
  try {
    await track.applyConstraints({
      width: { ideal: hdVideoEnabled ? 1280 : 640, max: hdVideoEnabled ? 1920 : 1280 },
      height: { ideal: hdVideoEnabled ? 720 : 360, max: hdVideoEnabled ? 1080 : 720 },
      frameRate: { ideal: 30, max: 30 }
    });
  } catch (err) {
    status("The camera could not apply the selected video quality; using the available quality.");
  }
  const sender = peer?.getSenders().find(item => item.track?.kind === "video");
  if (sender?.getParameters && sender?.setParameters) {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = hdVideoEnabled ? 2500000 : 800000;
      await sender.setParameters(params);
    } catch (err) { /* Keep the browser's negotiated bitrate. */ }
  }
}
async function preparePeer(mode) {
  callMode=mode;
  callCameraFacing = "user";
  localStream=await navigator.mediaDevices.getUserMedia(callMediaConstraints(mode));
  $("localVideo").srcObject=localStream;
  $("localVideo").classList.toggle("hidden",mode!=="video");
  $("remoteVideo").classList.toggle("hidden",mode!=="video");
  peer=new RTCPeerConnection(rtcConfig);
  localStream.getTracks().forEach(track=>peer.addTrack(track,localStream));
  if (mode === "video") {
    const videoSender = peer.getSenders().find(sender => sender.track?.kind === "video");
    if (videoSender?.getParameters && videoSender?.setParameters) {
      try {
        const params = videoSender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].maxBitrate = hdVideoEnabled ? 2500000 : 800000;
        await videoSender.setParameters(params);
      } catch (err) { /* Browser/network may choose its own bitrate. */ }
    }
  }
  peer.ontrack=event=>{$("remoteVideo").srcObject=event.streams[0];};
  peer.onicecandidate=event=>{if(event.candidate)sendSignal({type:"ice",candidate:event.candidate});};
  peer.onconnectionstatechange=()=>{if(peer)$("callStatus").textContent=peer.connectionState==="connected"?"Connected":`Call ${peer.connectionState}`;};
  $("callPanel").classList.remove("hidden"); $("callStatus").textContent="Connecting…";
  $("noiseBtn").textContent=`Noise cancellation: ${noiseCancellationEnabled ? "On" : "Off"}`;
  $("noiseBtn").setAttribute("aria-pressed", String(noiseCancellationEnabled));
  $("hdBtn").classList.toggle("hidden", mode !== "video");
  $("hdBtn").textContent=`HD video: ${hdVideoEnabled ? "On" : "Off"}`;
  $("hdBtn").setAttribute("aria-pressed", String(hdVideoEnabled));
  $("switchCallCameraBtn").classList.toggle("hidden", mode !== "video");
}
async function switchCallCamera() {
  if (!localStream || callMode !== "video" || !peer) return;
  const nextFacing = callCameraFacing === "user" ? "environment" : "user";
  const oldTrack = localStream.getVideoTracks()[0];
  try {
    const replacementStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { exact: nextFacing },
        width: { ideal: hdVideoEnabled ? 1280 : 640 },
        height: { ideal: hdVideoEnabled ? 720 : 360 },
        frameRate: { ideal: 30, max: 30 }
      }
    });
    const replacementTrack = replacementStream.getVideoTracks()[0];
    const sender = peer.getSenders().find(item => item.track?.kind === "video");
    if (!replacementTrack || !sender) throw new Error("Camera switching is not supported by this device.");
    await sender.replaceTrack(replacementTrack);
    localStream.removeTrack(oldTrack);
    localStream.addTrack(replacementTrack);
    oldTrack?.stop();
    $("localVideo").srcObject = localStream;
    callCameraFacing = nextFacing;
    $("switchCallCameraBtn").textContent = nextFacing === "user" ? "⇄ Front camera" : "⇄ Rear camera";
    status(`Switched to ${nextFacing === "user" ? "front" : "rear"} camera.`);
  } catch (err) {
    status(err.name === "OverconstrainedError" || err.name === "NotFoundError"
      ? "The requested camera is unavailable on this device."
      : `Could not switch camera: ${err.message}`);
  }
}

async function startCall(mode) {
  if(!activeFriend)return status("Open a private chat with a friend before calling.");
  if(peer||pendingIncomingCall)return status("A call is already active or incoming.");
  if(!navigator.mediaDevices?.getUserMedia)return status("Calls require HTTPS (or localhost) and camera/microphone permission.");
  try {
    await ensureCallChannel(activeFriend.id); await preparePeer(mode);
    activeCallAccepted=false; activeCallLogId=logCall({status:"No answer",mode,direction:"outgoing",peerProfile:activeFriend});
    const offer=await peer.createOffer(); await peer.setLocalDescription(offer);
    sendSignal({type:"offer",mode,description:peer.localDescription,callerName:user.email?.split("@")[0]||"Your friend"});
    $("callStatus").textContent="Ringing… waiting for your friend to accept";
    clearTimeout(ringTimeout); ringTimeout=setTimeout(()=>{if(peer&&!activeCallAccepted){updateCallLog("No answer");status("No answer.");endCall(true);}},45000);
  } catch(err){status(`Could not start call: ${err.message}`);endCall(false);}
}
async function acceptIncomingCall() {
  if(!pendingIncomingCall||!activeFriend)return;
  const incoming=pendingIncomingCall; $("incomingCall").classList.add("hidden");
  try {
    await preparePeer(incoming.mode); await peer.setRemoteDescription(incoming.description);
    const answer=await peer.createAnswer(); await peer.setLocalDescription(answer);
    sendSignal({type:"answer",description:peer.localDescription});
    for(const c of queuedIce.splice(0))await peer.addIceCandidate(c);
    pendingIncomingCall=null; activeCallAccepted=true; updateCallLog("Accepted"); $("callStatus").textContent="Connected";
  } catch(err){status(`Could not accept call: ${err.message}`);endCall(false);}
}
function declineIncomingCall() {
  if(pendingIncomingCall){sendSignal({type:"decline"});updateCallLog("Rejected");}
  pendingIncomingCall=null; $("incomingCall").classList.add("hidden"); $("callPanel").classList.add("hidden");
}
function endCall(notify=true) {
  clearTimeout(ringTimeout); ringTimeout=null;
  if(activeCallAccepted)updateCallLog("Accepted");
  if(notify&&callChannel&&callPeerId)sendSignal({type:"hangup"});
  if(peer){peer.ontrack=null;peer.close();} peer=null;
  if(localStream)localStream.getTracks().forEach(t=>t.stop());
  localStream=null;muted=false;cameraOff=false;pendingIncomingCall=null;queuedIce=[];
  $("localVideo").srcObject=null;$("remoteVideo").srcObject=null;
  $("callPanel").classList.add("hidden");$("incomingCall").classList.add("hidden");
  $("muteBtn").textContent="Mute mic";$("cameraBtn").textContent="Camera off";
  activeCallLogId=null; activeCallAccepted=false;
}
$("voiceBtn").addEventListener("click",()=>startCall("audio"));
$("videoBtn").addEventListener("click",()=>startCall("video"));
$("acceptCallBtn").addEventListener("click",acceptIncomingCall);
$("declineCallBtn").addEventListener("click",declineIncomingCall);
$("hangupBtn").addEventListener("click",()=>endCall(true));
$("muteBtn").addEventListener("click",()=>{if(!localStream)return;muted=!muted;localStream.getAudioTracks().forEach(t=>t.enabled=!muted);$("muteBtn").textContent=muted?"Unmute mic":"Mute mic";});
$("noiseBtn").addEventListener("click",async()=>{noiseCancellationEnabled=!noiseCancellationEnabled;await applyNoiseCancellation();$("noiseBtn").textContent=`Noise cancellation: ${noiseCancellationEnabled ? "On" : "Off"}`;$("noiseBtn").setAttribute("aria-pressed",String(noiseCancellationEnabled));});
$("hdBtn").addEventListener("click",async()=>{hdVideoEnabled=!hdVideoEnabled;await applyVideoQuality();$("hdBtn").textContent=`HD video: ${hdVideoEnabled ? "On" : "Off"}`;$("hdBtn").setAttribute("aria-pressed",String(hdVideoEnabled));});
$("cameraBtn").addEventListener("click",()=>{if(!localStream)return;cameraOff=!cameraOff;localStream.getVideoTracks().forEach(t=>t.enabled=!cameraOff);$("cameraBtn").textContent=cameraOff?"Camera on":"Camera off";});
$("switchCallCameraBtn").addEventListener("click", switchCallCamera);
$("videoSizeBtn").addEventListener("click",()=>{videoExpanded=!videoExpanded;$("callPanel").classList.toggle("video-expanded",videoExpanded);$("videoSizeBtn").textContent=videoExpanded?"Smaller video":"Larger video";});
boot();

if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(()=>{});


// Hold the Send button briefly to record a voice message. Releasing opens a
// preview with delete, pause/resume, and send controls. Requires HTTPS and mic permission.
const voiceDrafts = { dm: null, room: null };
const voiceRecorders = { dm: null, room: null };
const voiceChunks = { dm: [], room: [] };
const voiceTimers = { dm: null, room: null };
const voiceState = { dm: {started:false, held:false, stream:null}, room: {started:false, held:false, stream:null} };
function voiceElements(kind) {
  const prefix = kind === "dm" ? "dm" : "room";
  return { preview: $(prefix+"VoicePreview"), pause: $(prefix+"VoicePause"), audio: $(prefix+"VoiceAudio"), del: $(prefix+"VoiceDelete"), send: $(prefix+"VoiceSend"), status: $(prefix+"VoiceStatus"), form: $(kind === "dm" ? "dmMessageForm" : "messageForm"), input: $(kind === "dm" ? "dmMessageInput" : "messageInput") };
}
function resetVoiceDraft(kind) {
  const el=voiceElements(kind); voiceDrafts[kind]=null;
  if(el.audio){if(el.audio.src.startsWith("blob:"))URL.revokeObjectURL(el.audio.src);el.audio.removeAttribute("src");el.audio.load();}
  if(el.preview) el.preview.classList.add("hidden");
  if(el.status) el.status.textContent="Voice message ready";
  if(el.pause) el.pause.textContent="Play preview";
}
async function beginVoiceRecording(kind) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { status("Voice recording needs a supported browser and HTTPS connection."); return; }
  const state=voiceState[kind];
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    if (!state.held) { stream.getTracks().forEach(t=>t.stop()); return; }
    state.stream=stream; voiceChunks[kind]=[];
    let options={};
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) options.mimeType="audio/webm;codecs=opus";
    else if (MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) options.mimeType="audio/ogg;codecs=opus";
    const recorder=new MediaRecorder(stream,options); voiceRecorders[kind]=recorder;
    recorder.addEventListener("dataavailable",e=>{if(e.data?.size)voiceChunks[kind].push(e.data);});
    recorder.addEventListener("stop",()=>{
      stream.getTracks().forEach(t=>t.stop()); state.stream=null;
      const mime=recorder.mimeType||"audio/webm";
      const blob=new Blob(voiceChunks[kind],{type:mime});
      if(blob.size){voiceDrafts[kind]=blob;const el=voiceElements(kind);el.audio.src=URL.createObjectURL(blob);el.preview.classList.remove("hidden");el.status.textContent=`Voice message ready · ${Math.max(1,Math.round(blob.size/1024))} KB`;}
      else status("No audio was recorded. Please try again.");
      voiceRecorders[kind]=null;
    });
    recorder.start(250); state.started=true;
    status("Recording voice message… release the Send button to finish.");
  } catch(error) { state.held=false; status(error.name==="NotAllowedError"?"Microphone permission was denied.":`Could not start recording: ${error.message}`); }
}
function stopVoiceRecording(kind) {
  const recorder=voiceRecorders[kind];
  if(recorder && recorder.state!=="inactive") recorder.stop();
  voiceState[kind].started=false;
}
async function uploadAndSendVoice(kind) {
  const blob=voiceDrafts[kind]; if(!blob) return;
  if(kind==="dm" && !activeFriend){status("Open a private chat first.");return;}
  if(kind==="room" && !activeRoom){status("Open a group chat first.");return;}
  const el=voiceElements(kind); el.send.disabled=true; el.status.textContent="Sending voice message…";
  const ext=blob.type.includes("ogg")?"ogg":blob.type.includes("mp4")?"m4a":"webm";
  const path=`${user.id}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
  const {error:uploadError}=await supabase.storage.from("chat-voice").upload(path,blob,{contentType:blob.type||"audio/webm",upsert:false});
  if(uploadError){el.send.disabled=false;el.status.textContent="Upload failed";status(`Voice upload failed: ${uploadError.message}`);return;}
  const {data}=supabase.storage.from("chat-voice").getPublicUrl(path);
  const payload={sender_id:user.id,body:"Voice message",message_type:"voice",media_url:data.publicUrl};
  const result=kind==="dm"
    ? await supabase.from("direct_messages").insert({...payload,receiver_id:activeFriend.id}).select("id").single()
    : await supabase.from("messages").insert({...payload,room_id:activeRoom.id}).select("id").single();
  el.send.disabled=false;
  if(result.error){status(`Could not send voice message: ${result.error.message}`);return;}
  sendPushNotification(result.data.id, kind === "dm" ? "direct" : "group");
  resetVoiceDraft(kind); status("Voice message sent.");
}
function attachVoiceControls(kind) {
  const el=voiceElements(kind); const state=voiceState[kind];
  const button=el.form?.querySelector(".send-btn"); if(!button)return;
  button.title="Tap to send text. Press and hold to record a voice message.";
  button.setAttribute("aria-label",button.title);
  button.addEventListener("pointerdown",e=>{
    if(e.button!==undefined && e.button!==0)return;
    state.held=true; state.started=false;
    voiceTimers[kind]=setTimeout(()=>{if(state.held){state.started=true;beginVoiceRecording(kind);}},280);
  });
  const finish=e=>{
    if(!state.held)return;
    state.held=false;
    if(voiceTimers[kind]){clearTimeout(voiceTimers[kind]);voiceTimers[kind]=null;}
    if(state.started){e.preventDefault();e.stopPropagation();stopVoiceRecording(kind);button.dataset.voiceHandled="1";setTimeout(()=>delete button.dataset.voiceHandled,450);}
  };
  button.addEventListener("pointerup",finish);
  button.addEventListener("pointerleave",e=>{if(state.started)finish(e);else{state.held=false;if(voiceTimers[kind])clearTimeout(voiceTimers[kind]);}});
  button.addEventListener("pointercancel",finish);
  button.addEventListener("click",e=>{if(button.dataset.voiceHandled==="1"){e.preventDefault();e.stopImmediatePropagation();}} ,true);
  el.del.addEventListener("click",()=>{resetVoiceDraft(kind);status("Voice recording deleted.");});
  el.pause.addEventListener("click",async()=>{
    if(!el.audio.src)return;
    if(el.audio.paused){try{await el.audio.play();el.pause.textContent="Pause preview";}catch(error){status(`Could not play preview: ${error.message}`);}}
    else{el.audio.pause();el.pause.textContent="Resume preview";}
  });
  el.audio.addEventListener("play",()=>{el.pause.textContent="Pause preview";});
  el.audio.addEventListener("pause",()=>{el.pause.textContent="Resume preview";});
  el.audio.addEventListener("ended",()=>{el.pause.textContent="Play preview";});
  el.send.addEventListener("click",()=>uploadAndSendVoice(kind));
}
attachVoiceControls("dm");
attachVoiceControls("room");

// Safe automatic refresh: sync new chat data without reloading the document.
// This deliberately does not touch the WebRTC peer, microphone/camera streams,
// or call signalling channel, so an active voice/video call is not interrupted.
let softSyncRunning = false;
let lastSoftSyncAt = 0;
async function softSyncChatData() {
  if (!supabase || !user || softSyncRunning || !navigator.onLine) return;
  softSyncRunning = true;
  try {
    // Ask Supabase Realtime to reconnect if the network was briefly unavailable.
    // Existing channels are allowed to recover; do not recreate call channels.
    try { supabase.realtime.connect(); } catch (_) {}

    if (activeRoom) {
      const roomId = activeRoom.id;
      const { data, error } = await supabase.from("messages").select("*")
        .eq("room_id", roomId).order("created_at", { ascending: true }).limit(200);
      if (!error && activeRoom?.id === roomId) (data || []).forEach(renderMessage);
    } else if (activeFriend) {
      const friendId = activeFriend.id;
      const pairFilter = `and(sender_id.eq.${user.id},receiver_id.eq.${friendId}),and(sender_id.eq.${friendId},receiver_id.eq.${user.id})`;
      const { data, error } = await supabase.from("direct_messages").select("*")
        .or(pairFilter).order("created_at", { ascending: true }).limit(300);
      if (!error && activeFriend?.id === friendId) (data || []).forEach(renderDirectMessage);
    }
    lastSoftSyncAt = Date.now();
  } catch (error) {
    console.warn("ConnectChat background sync failed:", error);
  } finally {
    softSyncRunning = false;
  }
}

window.addEventListener("offline", () => {
  status("You are offline. Your current call will stay open; reconnecting automatically when internet returns.");
});
window.addEventListener("online", () => {
  status("Internet restored. Reconnecting and syncing messages…");
  setTimeout(softSyncChatData, 800);
});
window.addEventListener("pageshow", () => {
  // Browser Back/Forward restoration: sync data only, never force a full reload.
  if (navigator.onLine) softSyncChatData();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && navigator.onLine && Date.now() - lastSoftSyncAt > 10000) softSyncChatData();
});
// Refresh all dashboard sections every 10 seconds without reloading the document.
// This SPA has one document containing the chat, friends, requests and groups views.
// Refresh list data in place and sync the currently open conversation. Never touch
// localStream, peer, callChannel, or active call state, so a refresh cannot itself
// terminate an ongoing WebRTC call. A real network outage can still interrupt a call.
async function refreshAllPagesData() {
  if (!supabase || !user || !navigator.onLine || document.hidden || softSyncRunning) return;
  const appIsOpen = appView && !appView.classList.contains("hidden");
  if (!appIsOpen) return;

  // Refresh all navigation/list views, not just the currently selected conversation.
  // These functions update their own list containers and do not navigate/reload.
  const jobs = [loadRooms(), loadFriendRequests(), loadFriends(), softSyncChatData()];
  await Promise.allSettled(jobs);
  await refreshUnreadCounts();
}

// Ten-second in-place refresh across the whole app. No location.reload() is used.
const AUTO_REFRESH_INTERVAL_MS = 10000;
setInterval(refreshAllPagesData, AUTO_REFRESH_INTERVAL_MS);
