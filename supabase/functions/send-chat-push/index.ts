import { createClient } from "npm:@supabase/supabase-js@2";
import { importPKCS8, SignJWT } from "npm:jose@5";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function getGoogleAccessToken(serviceAccount: any) {
  const key = await importPKCS8(serviceAccount.private_key, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccount.client_email)
    .setSubject(serviceAccount.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || "Google OAuth token request failed");
  return data.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: cors });
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return new Response("Unauthorized", { status: 401, headers: cors });

    const { messageId, conversationType } = await req.json();
    if (typeof messageId !== "string" || !["direct", "group"].includes(conversationType)) {
      return new Response("Invalid request", { status: 400, headers: cors });
    }

    const admin = createClient(supabaseUrl, serviceKey);
    let recipients: string[] = [];
    let body = "You have a new message.";
    let title = "New message on ConnectChat";
    let message: any;

    if (conversationType === "direct") {
      const result = await admin.from("direct_messages").select("id,sender_id,receiver_id,body,message_type").eq("id", messageId).maybeSingle();
      if (result.error || !result.data || result.data.sender_id !== user.id) return new Response("Message not found", { status: 404, headers: cors });
      message = result.data;
      recipients = [message.receiver_id];
    } else {
      const result = await admin.from("messages").select("id,sender_id,room_id,body,message_type").eq("id", messageId).maybeSingle();
      if (result.error || !result.data || result.data.sender_id !== user.id) return new Response("Message not found", { status: 404, headers: cors });
      message = result.data;
      const membership = await admin.from("room_members").select("user_id").eq("room_id", message.room_id).neq("user_id", user.id);
      recipients = (membership.data || []).map((row: any) => row.user_id);
    }

    const [senderProfile, roomInfo] = await Promise.all([
      admin.from("profiles").select("display_name,username,avatar_url").eq("id", user.id).maybeSingle(),
      conversationType === "group" ? admin.from("rooms").select("name").eq("id", message.room_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const senderName = senderProfile.data?.display_name || senderProfile.data?.username || "Someone";
    title = conversationType === "group" ? `${senderName} in ${roomInfo.data?.name || "a group"}` : senderName;
    body = message.message_type === "image" ? "📷 Photo" : message.message_type === "video" ? "🎬 Video" : message.message_type === "voice" ? "🎤 Voice message" : message.message_type === "file" ? "📎 File" : (message.body || "New message");
    body = String(body).slice(0, 180);
    if (!recipients.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { ...cors, "Content-Type": "application/json" } });

    const { data: tokenRows, error: tokenError } = await admin.from("device_tokens").select("id,user_id,fcm_token").in("user_id", recipients);
    if (tokenError) throw tokenError;
    if (!tokenRows?.length) return new Response(JSON.stringify({ sent: 0 }), { headers: { ...cors, "Content-Type": "application/json" } });

    const serviceAccountRaw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
    if (!serviceAccountRaw) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is not configured");
    const serviceAccount = JSON.parse(serviceAccountRaw);
    const accessToken = await getGoogleAccessToken(serviceAccount);
    const projectId = serviceAccount.project_id;
    let sent = 0;
    const staleTokenIds: string[] = [];
    for (const row of tokenRows) {
      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: {
          token: row.fcm_token,
          data: { messageId, conversationType, title, body, url: "./", senderAvatar: senderProfile.data?.avatar_url || "", notificationType: message.message_type || "text" },
        } }),
      });
      if (response.ok) sent++;
      else {
        const errorText = await response.text();
        console.error("FCM send failed", response.status, errorText);
        if (response.status === 404 || errorText.includes("UNREGISTERED") || errorText.includes("registration-token-not-registered")) staleTokenIds.push(row.id);
      }
    }
    if (staleTokenIds.length) await admin.from("device_tokens").delete().in("id", staleTokenIds);
    return new Response(JSON.stringify({ sent }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error?.message || "Internal server error" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
