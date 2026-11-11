
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

      if (context) {
        const body = typeof context.json === "function"
          ? await context.clone().json()
          : null;

        if (body?.error || body?.message) {
          message = body.error || body.message;
        }
      }
    } catch (e) {
      console.error("MOZA API error details:", e);
    }

    console.error("MOZA API request failed:", {
      action: name,
      message,
      error
    });

    throw new Error(message);
  }

  if (result?.error) {
    throw new Error(result.error);
  }

  return { data: result };
}
