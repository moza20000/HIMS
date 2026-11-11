
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  supabaseUrl,
  supabasePublishableKey
} from "./supabase-config.js";

// جلسة الإدارة
export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      storageKey: "moza-admin-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

export const { auth } = supabase;

export const signInWithPassword = (credentials) =>
  auth.signInWithPassword(credentials);

export const signOut = () => auth.signOut();

export const onAuthStateChanged = (callback) => {
  return auth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => callback(session?.user || null));
  });
};

// جلسة الطالب المستقلة
export const studentSupabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      storageKey: "moza-student-auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  }
);

export const studentAuth = studentSupabase.auth;

export const studentSignInWithPassword = (credentials) =>
  studentAuth.signInWithPassword(credentials);

export const studentSignOut = () => studentAuth.signOut();

export const onStudentAuthStateChanged = (callback) => {
  return studentAuth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => callback(session?.user || null));
  });
};

export const studentEmail = (code) =>
  `student-${String(code).trim().toLowerCase()}@moza-attendance.app`;

// استدعاء خدمات الإدارة
async function invoke(client, name, data = {}) {
  const { data: result, error } = await client.functions.invoke(
    "super-service",
    {
      body: { action: name, ...data }
    }
  );

  if (error) {
    let message = error.message || "تعذر الاتصال بالخدمة.";

    try {
      const context = error.context;
      if (context && typeof context.clone === "function") {
        const body = await context.clone().json();
        message = body.error || body.message || message;
      }
    } catch {}

    console.error("MOZA API error:", error);
    throw new Error(message);
  }

  if (result?.error) {
    throw new Error(result.error);
  }

  return { data: result };
}

// يظل هذا الاستدعاء للإدارة حتى لا نكسر admin.js
export async function call(name, data = {}) {
  return invoke(supabase, name, data);
}

// استدعاء خدمات الطالب بجلسة الطالب فقط
export async function callStudent(name, data = {}) {
  return invoke(studentSupabase, name, data);
}
