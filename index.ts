import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});
const fail = (message: string, status = 400) => json({ error: message }, status);
const url = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminDb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const cleanCode = (v: unknown) => {
  const code = String(v ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,32}$/.test(code)) throw new Error("كود الطالب يجب أن يتكون من 3 إلى 32 حرفًا أو رقمًا.");
  return code;
};
const studentEmail = (code: string) => `student-${code}@moza-attendance.app`;
const sha256 = async (value: string) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
};
const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

async function main(req: Request) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Method not allowed", 405);
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return fail("يجب تسجيل الدخول أولاً.", 401);

  const userClient = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser(jwt);
  if (authError || !authData.user) return fail("جلسة الدخول غير صالحة. سجّل الدخول مرة أخرى.", 401);
  const uid = authData.user.id;
  const { data: profile, error: profileError } = await adminDb.from("profiles")
    .select("id,name,code,role,active").eq("id", uid).maybeSingle();
  if (profileError || !profile || !profile.active) return fail("الحساب غير نشط أو غير مسجل.", 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const isAdmin = ["owner", "admin"].includes(profile.role);
  const requireAdmin = () => {
    if (!isAdmin) throw new Error("صلاحيات الإدارة مطلوبة.");
  };
  const audit = async (name: string, details: Record<string, unknown> = {}) => {
    const { error } = await adminDb.from("audit_logs").insert({ action: name, admin_uid: uid, details });
    if (error) throw error;
  };

  try {
    if (action === "createStudent") {
      requireAdmin();
      const name = String(body.name || "").trim();
      const code = cleanCode(body.code);
      const nationalId = String(body.nationalId || "").trim();
      if (name.length < 3 || name.length > 100) throw new Error("اكتب اسم الطالب بالكامل.");
      if (!/^[0-9]{14}$/.test(nationalId)) throw new Error("الرقم القومي يجب أن يتكون من 14 رقمًا.");
      const { data: created, error } = await adminDb.auth.admin.createUser({
        email: studentEmail(code), password: nationalId, email_confirm: true,
        user_metadata: { name, code },
      });
      if (error) {
        if (error.message.toLowerCase().includes("already")) throw new Error("كود الطالب مستخدم بالفعل.");
        throw error;
      }
      // The auth trigger creates the profile; upsert is a safe fallback if triggers were delayed.
      const { error: saveError } = await adminDb.from("profiles").upsert({
        id: created.user.id, name, code, role: "student", active: true,
      }, { onConflict: "id" });
      if (saveError) {
        await adminDb.auth.admin.deleteUser(created.user.id);
        throw saveError;
      }
      await audit("student_created", { studentUid: created.user.id, code });
      return json({ uid: created.user.id, name, code });
    }

    if (action === "updateStudent") {
      requireAdmin();
      const target = String(body.uid || "");
      const name = String(body.name || "").trim();
      if (!target || name.length < 3 || name.length > 100) throw new Error("بيانات غير صحيحة.");
      const { data: student, error: readError } = await adminDb.from("profiles").select("id,role").eq("id", target).maybeSingle();
      if (readError || !student || student.role !== "student") throw new Error("الطالب غير موجود.");
      const { error } = await adminDb.from("profiles").update({ name }).eq("id", target);
      if (error) throw error;
      await adminDb.auth.admin.updateUserById(target, { user_metadata: { name } });
      await audit("student_updated", { studentUid: target });
      return json({ ok: true });
    }

    if (action === "setStudentActive") {
      requireAdmin();
      const target = String(body.uid || "");
      const active = body.active === true;
      const { data: student, error: readError } = await adminDb.from("profiles").select("id,role").eq("id", target).maybeSingle();
      if (readError || !student || student.role !== "student") throw new Error("الطالب غير موجود.");
      const { error } = await adminDb.from("profiles").update({ active }).eq("id", target);
      if (error) throw error;
      await audit(active ? "student_activated" : "student_disabled", { studentUid: target });
      return json({ ok: true });
    }

    if (action === "createSession") {
      requireAdmin();
      const title = String(body.title || "").trim();
      const durationMinutes = Number(body.durationMinutes);
      if (title.length < 2 || title.length > 100) throw new Error("اسم المحاضرة غير صحيح.");
      if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 600)
        throw new Error("مدة QR يجب أن تكون بين دقيقة و10 ساعات.");
      const token = randomToken();
      const expiresAt = new Date(Date.now() + durationMinutes * 60000).toISOString();
      const { data: session, error } = await adminDb.from("sessions").insert({
        title, created_by: uid, expires_at: expiresAt, active: true, token_hash: await sha256(token),
      }).select("id,title,expires_at").single();
      if (error) throw error;
      await audit("session_created", { sessionId: session.id, title });
      return json({ id: session.id, title: session.title, token, expiresAt: new Date(session.expires_at).getTime() });
    }

    if (action === "endSession") {
      requireAdmin();
      const sessionId = String(body.sessionId || "");
      if (!sessionId) throw new Error("الجلسة غير محددة.");
      const { error } = await adminDb.from("sessions").update({ active: false }).eq("id", sessionId);
      if (error) throw error;
      await audit("session_ended", { sessionId });
      return json({ ok: true });
    }

    if (action === "markAttendance") {
      if (profile.role !== "student") throw new Error("هذه الخدمة مخصصة لحسابات الطلاب.");
      const sessionId = String(body.sessionId || "");
      const token = String(body.token || "");
      if (!sessionId || token.length < 20) throw new Error("رمز QR غير صالح.");
      const { data: session, error } = await adminDb.from("sessions")
        .select("id,title,expires_at,active,token_hash").eq("id", sessionId).maybeSingle();
      if (error || !session) throw new Error("المحاضرة غير موجودة.");
      if (!session.active || Date.now() > new Date(session.expires_at).getTime()) throw new Error("انتهت صلاحية رمز الحضور.");
      if (await sha256(token) !== session.token_hash) throw new Error("رمز QR غير صحيح.");
      const { error: insertError } = await adminDb.from("attendance").insert({
        student_id: uid, student_name: profile.name, student_code: profile.code || "",
        session_id: session.id, session_title: session.title, status: "present",
      });
      if (insertError) {
        if (insertError.code === "23505") throw new Error("تم تسجيل حضورك في هذه المحاضرة بالفعل.");
        throw insertError;
      }
      return json({ ok: true, studentName: profile.name, sessionTitle: session.title });
    }
    return fail("عملية غير معروفة.", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "حدث خطأ غير متوقع.";
    return fail(message, 400);
  }
}

Deno.serve(main);
