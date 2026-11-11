
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  supabaseUrl,
  supabasePublishableKey
} from "./supabase-config.js";

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
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

export const onAuthStateChanged = (callback) =>
  auth.onAuthStateChange((_event, session) => {
    queueMicrotask(() => callback(session?.user || null));
  });

export const studentEmail = (code) =>
  `student-${String(code).trim().toLowerCase()}@moza-attendance.app`;

export async function call(name, data = {}) {
  const { data: result, error } = await supabase.functions.invoke(
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
