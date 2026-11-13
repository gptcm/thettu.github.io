# ConnectChat Rich Background Push – deployment notes

This package updates the Firebase service worker to display background notifications with the sender profile image, message preview, and a tap-to-open action. The Edge Function now includes `profiles.avatar_url` in the FCM data payload.

## Required setup (do this before testing)

1. In Supabase SQL Editor, run `fcm-device-tokens.sql` if `public.device_tokens` does not already exist.
2. Deploy the function from the `connectchat` directory:

   `supabase functions deploy send-chat-push`

3. Set the Supabase Edge Function secret `FIREBASE_SERVICE_ACCOUNT` to the **contents of a newly generated Firebase service-account JSON key**. Never put that JSON file in the website folder, GitHub, or this ZIP.
4. In Firebase Console, ensure Cloud Messaging is enabled and the Web Push VAPID public key in `app.js` matches the Firebase project's key.
5. Deploy the whole `connectchat` folder over HTTPS. Keep `sw.js` at the app's root so its scope covers the app.
6. Each user/device must sign in, turn on Notifications in ConnectChat Settings, and allow the browser/OS permission. Repeat on every browser/device.
7. Send a test message from a second account/device while the recipient's app tab is closed. Check the browser/OS notification settings if nothing appears.

## What this patch currently provides

- Background FCM notification while the browser supports web push and the device is online.
- Sender display name and profile image (`avatar_url`) in the push payload/notification.
- Text, image, video, and voice-message labels using the existing message types.
- Tap notification to open ConnectChat and carry the message ID in the URL query string.

## Important feature boundaries

- This update does **not** implement a working notification quick-reply action, nor does it implement incoming voice/video call push delivery or Answer/Decline call signaling. Those require additional authenticated server-side call-invite creation, expiry/cancel handling, and integration with the app's existing WebRTC signaling. Do not treat the call labels in the worker as a completed call system.
- Notification layouts/actions differ by Android, iOS, Windows, and browser. Web Push on iPhone/iPad requires an eligible iOS version and the web app added to the Home Screen. A web page cannot guarantee a full call UI or media playback directly inside every OS notification.
- The app must have a server-side event path that invokes `send-chat-push` for each new message. Existing text send paths invoke it; verify attachment/voice paths in your deployment.
- Keep Firebase service-account private keys only in Supabase Edge Function secrets. If a key was previously included in a shared ZIP/repository, revoke it in Google Cloud/Firebase IAM and create a replacement immediately.


## Notification sounds
The Settings panel now includes a per-user sound selector and a Test sound button. These tones use the Web Audio API while ConnectChat is open/active (and when a foreground FCM message is received). Browsers generally do not allow a service worker to play an arbitrary custom audio file while the site is fully closed. In that state, the operating system/browser uses its own notification sound settings; Android may also support the vibration pattern in `sw.js`, while iOS/desktop support varies. Users must allow notifications and interact with the page once to unlock audio playback.
