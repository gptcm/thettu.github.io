# ConnectChat

A responsive, browser-based messaging and one-to-one voice/video calling starter app.

## Included
- Email/password sign-up and login (Supabase Auth)
- Invite-code chat rooms
- Real-time room messages (Supabase Realtime)
- Username and display-name profiles
- Friend search, friend requests and accept/decline
- Private one-to-one text messaging between accepted friends
- Voice/video calls using WebRTC
- Responsive layout for phones, tablets and desktops
- No paid API key is required for the basic setup

## 1. Create the free backend
1. Create a project at https://supabase.com/.
2. In the project dashboard, open **SQL Editor**.
3. Create a new query, paste all of `schema.sql`, and run it.
4. Open **Project Settings → API** and copy the Project URL and `anon` / publishable public key.
5. In `app.js`, replace:
   - `YOUR_SUPABASE_URL`
   - `YOUR_SUPABASE_ANON_KEY`
6. In Supabase **Authentication → URL Configuration**, add your deployed site URL to the allowed redirect URLs. For local testing, add `http://localhost:8000`.

Do not use the Supabase `service_role` secret in frontend code.

## 2. Enable friend search and private chats
After the original `schema.sql` has been run, open Supabase **SQL Editor → New query**, paste the full contents of `friends.sql`, and click **Run**. This additive migration also creates the `profile-avatars` Storage bucket and its access policies for profile pictures; do not rerun the original schema for this step.

Each existing account gets an automatically generated username. In ConnectChat, edit the username and display name in the **Find friends** panel. Search by username or display name, send a friend request, and accept requests to unlock private one-to-one messaging. Friend search is available only to signed-in users. Private messages are protected by Row Level Security and only the two accepted friends can read them.

## 3. Run locally
A secure context is required for camera and microphone. `localhost` is allowed by browsers.

With Python installed, open a terminal in this folder and run:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## 4. Publish it free
You can deploy the folder as a static site using a free static-hosting tier such as Cloudflare Pages, Netlify, or GitHub Pages:
- Upload/connect this project folder.
- No build command is needed.
- Set the output/publish directory to the project root.
- Add the final HTTPS site URL to Supabase Auth's allowed redirect URLs.

Free-tier quotas and terms can change. You need an internet connection to use the app.

## 5. How to use
1. Create an account and log in.
2. Select **＋** to create a room.
3. Share the six-character invite code with another person.
4. They create an account, enter the code and join.
5. Both people can chat. Use **Voice** or **Video** to start a call while both are in the room.


## 6. Firebase Cloud Messaging (background push notifications)

The Settings → Notifications switch controls push notifications **for the current browser/device**. When enabled, ConnectChat asks for browser permission, gets an FCM registration token, and stores it in Supabase. When disabled, it removes that device token from Supabase. Browser permission itself cannot be revoked by a website; if it was granted earlier, the switch controls whether ConnectChat registers that device for pushes.

### Firebase setup
1. Create a Firebase project at https://console.firebase.google.com/ and add a **Web app**.
2. In **Project settings → General → Your apps**, copy the Firebase web config into `FIREBASE_CONFIG` in `app.js` and `firebaseConfig` in `sw.js`. Both blocks must match exactly.
3. In **Project settings → Cloud Messaging → Web Push certificates**, generate/copy the public VAPID key into `FIREBASE_VAPID_KEY` in `app.js`.
4. In Firebase Project Settings → Service accounts, generate a private key JSON. Keep this JSON private; never put it in browser files or commit it.
5. In Supabase SQL Editor, run `fcm-device-tokens.sql`.
6. Deploy the Edge Function from the project root (requires the Supabase CLI and a linked Supabase project):

```bash
supabase functions deploy send-chat-push
# macOS / Linux / Git Bash: use the complete downloaded service-account JSON file
supabase secrets set FIREBASE_SERVICE_ACCOUNT="$(cat ./service-account.json)"
```

   In Windows PowerShell, use `$sa = Get-Content .\service-account.json -Raw` and then `supabase secrets set FIREBASE_SERVICE_ACCOUNT="$sa"`. Set `FIREBASE_SERVICE_ACCOUNT` to the **entire contents** of the Firebase service-account key file. Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to Edge Functions automatically. Ensure the Firebase service account has permission to send Firebase Cloud Messaging messages (Firebase Cloud Messaging API enabled in Google Cloud).
7. Host ConnectChat on HTTPS (localhost is allowed for local development), reload the page, sign in, open Settings, and switch Notifications ON on each device/browser.

### How it works
- Text, image, video, file, and voice messages invoke `send-chat-push` after the message is saved.
- The Edge Function authenticates the sender, verifies the message belongs to that sender, resolves the direct-message recipient or group members, and sends through FCM HTTP v1.
- The existing `sw.js` handles background notifications and notification clicks.
- FCM tokens are per browser/device. Turn the switch ON separately on every device where pushes are wanted.

### Important notes
- FCM web push requires HTTPS, a supported browser, browser notification permission, the Firebase web config, a VAPID public key, the Supabase SQL migration, and the deployed Edge Function/secrets.
- Turning the switch OFF removes the current device's FCM token from the server. It does not change the browser's site-level permission; use browser site settings to revoke that permission entirely.
- Test with two accounts and two browsers/devices. Keep the recipient browser closed or in the background to test background push. Some mobile browsers have platform-specific push restrictions.
- The Firebase service-account private key and Supabase service-role key must never be added to `app.js`, `sw.js`, or any other public frontend file.

## Important calling limitations
- Calls use browser WebRTC and a public STUN server. STUN helps peers discover network routes but does not relay media.
- Some mobile networks, corporate networks, carrier-grade NATs and restrictive firewalls require a TURN relay. A reliable production calling service may therefore have a cost.
- This starter supports one-to-one calls, not multi-person group calls.
- Both participants should keep the room open and allow microphone/camera access.
- Calls require HTTPS on deployed sites (or localhost for local development).
- Browsers may block autoplay; tap the page if remote audio does not start.

## Security and production checklist
Before launching to the public:
- Use long, random invite codes and add rate limits / abuse reporting.
- Add profile photos, blocking, reporting and account recovery before public launch.
- Add moderation, blocking, account deletion and message retention controls.
- Configure email confirmation and password recovery.
- Consider private Realtime channels and a TURN provider.
- Review Supabase RLS policies and test with separate accounts.
- Add end-to-end encryption if your product requires it; this starter does not provide it.

## Project files
- `index.html` — application layout
- `styles.css` — responsive styling
- `app.js` — authentication, rooms, messaging and WebRTC calling
- `schema.sql` — original room database tables, access policies and RPC functions
- `friends.sql` — friend profiles, requests, private messages and security policies
- `manifest.webmanifest` — installable web app metadata
- `sw.js` — basic offline shell cache


## Interface, themes and product design

ConnectChat uses a familiar modern messenger layout while keeping its own name, visual identity and interface:
- **Navigation:** conversation and friend tools on the left; active conversation and call controls on the right.
- **Account experience:** email sign-up, sign-in, profile name and username.
- **Messaging:** room chats and accepted-friend private chats, with a message composer and live updates.
- **Calling:** one-to-one voice and video calling, incoming-call actions, mute, camera toggle, resize and hang-up controls.
- **Responsive behaviour:** desktop two-column workspace; compact sidebar and chat layout on mobile.
- **Theme system:** click the theme control in the top bar to cycle through Midnight, Light, Ocean, Forest and Sunset. The selected theme is saved in the browser using local storage.
- **Accessibility basics:** semantic forms, input labels, visible keyboard focus and live status regions.

### Suggested next product features
For a public production release, plan to add profile pictures, delivery/read states, typing indicators, message search, emoji/reactions, file and image attachments, pinned messages, archived chats, notification preferences, contact blocking, user reporting, account deletion, backup/export and end-to-end encryption. These are product roadmap concepts, not currently implemented features.

### Important security and privacy notes
This starter is not an official WhatsApp product and is not affiliated with WhatsApp or Meta. It does not currently implement end-to-end encryption. Do not use it for sensitive conversations until you have independently reviewed the backend policies, authentication, transport, retention and security. Never put a Supabase service-role secret in browser code. Use only the public anon/publishable key in the frontend.


### Group names
New groups ask for a name when created. The group creator can rename the group from the chat header using **Edit name**. Existing Supabase projects must run `group-name-migration.sql` once in the Supabase SQL Editor. New installations can run the updated `schema.sql`. Group names are limited to 40 characters; only the creator can edit the name.

## Voice messages

In a private or group chat, **press and hold the Send button for about 0.3 seconds** to start recording. Release to finish and open the voice preview. The preview includes **Delete** (left side), **Pause/Resume**, and **Send voice**. Tap Send normally to send a text message. Voice playback appears inline in the conversation.

Voice recording requires microphone permission and a secure context (HTTPS, or localhost during development). After running `schema.sql` and `friends.sql`, run `voice-messages-migration.sql` in Supabase SQL Editor to add voice-message columns and create the `chat-voice` Storage bucket and upload policy. Voice clips are limited to 15 MB. If the migration has not been run, text messaging continues to work but voice uploads will fail.


## Message deletion
Run `message-deletion-migration.sql` once in Supabase SQL Editor after the other setup/migration scripts. In a private or group chat, press and hold a sent or received message for about half a second to select it. Select more messages by tapping them, then choose **Delete for me** or **Delete for everyone**. Delete for everyone is available only when all selected messages were sent by your account. Delete for me hides the selected messages only from your account; delete for everyone replaces the message content for all chat participants. The migration adds the required database functions and per-user deletion state.


## Cross-device unread-message synchronization

To synchronize private-chat and group unread counts between a user's phone, tablet and computer, run `unread-sync-migration.sql` once in Supabase Dashboard → SQL Editor **after** `schema.sql` and `friends.sql`. This creates a per-user conversation read-state table protected by Row Level Security and adds it to Supabase Realtime. The app stores each conversation's last-read time in Supabase, listens for read-state changes from the user's other signed-in devices, and recalculates unread counts from the server. Existing local read positions are used to seed the server the first time this migration is enabled; otherwise a conversation starts with the current time as its read position. Read timestamps are monotonic so a delayed update from another device cannot move the read position backwards.

This feature requires the migration to be run on the same Supabase project configured in `app.js`. If the migration has not been run, the app will show a setup message and cross-device synchronization will not work. Test with two separate devices signed in to the same account: open a conversation on one device and verify that its unread badge clears on the other. Different accounts still have separate read states, as expected.

## Image, video and file attachments
The chat composer now has a **＋ attachment button at the bottom-left** in both private and group chats. It can send images, videos and other files (up to 50 MB each). Images display in the conversation, videos have an in-chat player, and other files appear as downloadable links.

Before using attachments, run `chat-attachments-migration.sql` in Supabase Dashboard → SQL Editor after the existing schema, friends and voice-message migrations. This creates the public `chat-media` storage bucket, adds the attachment filename column and permits authenticated users to upload only into their own storage folder. Keep your Supabase anon/publishable key in the client; never expose a service-role key.
