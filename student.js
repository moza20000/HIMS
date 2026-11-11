
import {
  studentSupabase,
  studentAuth,
  studentSignInWithPassword,
  studentSignOut,
  onStudentAuthStateChanged,
  callStudent,
  studentEmail
} from "./supabase.js";

const $ = (id) => document.getElementById(id);

let scanner = null;
let scanning = false;
let processingQR = false;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);

const msg = (id, text, type = "notice") => {
  const element = $(id);
  if (element) {
    element.innerHTML =
      `<div class="notice ${type}">${esc(text)}</div>`;
  }
};

function setView(loggedIn) {
  $("loginView").style.display = loggedIn ? "none" : "grid";
  $("studentView").style.display = loggedIn ? "block" : "none";
}

async function showUser(user) {
  if (!user) {
    setView(false);
    return;
  }

  try {
    const { data: profile, error } = await studentSupabase
      .from("profiles")
      .select("id,name,code,branch,active,role")
      .eq("id", user.id)
      .maybeSingle();

    if (error) {
      console.error("Profile loading error:", error);
      await studentSignOut();
      setView(false);

      msg(
        "loginMsg",
        "تعذر قراءة بيانات الطالب. تحقق من صلاحيات قاعدة البيانات.",
        "error"
      );
      return;
    }

    if (
      !profile ||
      profile.active !== true ||
      profile.role !== "student"
    ) {
      await studentSignOut();
      setView(false);

      msg(
        "loginMsg",
        "الحساب غير نشط أو غير مسجل كطالب.",
        "error"
      );
      return;
    }

    $("welcomeName").textContent =
      `أهلاً ${profile.name || "بك"}`;

    $("welcomeBranch").textContent =
      `الشعبة: ${profile.branch || "غير محددة"}`;

    setView(true);

  } catch (error) {
    console.error("Student session error:", error);
    await studentSignOut();
    setView(false);

    msg(
      "loginMsg",
      "حدث خطأ أثناء تحميل بيانات الحساب.",
      "error"
    );
  }
}

onStudentAuthStateChanged((user) => {
  showUser(user);
});

// =====================================
// تسجيل دخول الطالب
// =====================================

$("studentLogin").onclick = async () => {
  $("loginMsg").innerHTML = "";

  const code = $("studentCode").value.trim();
  const nationalId = $("studentNationalId").value.trim();

  if (
    !/^[a-zA-Z0-9_-]{3,32}$/.test(code) ||
    !/^[0-9]{14}$/.test(nationalId)
  ) {
    msg(
      "loginMsg",
      "تأكد من كود الطالب والرقم القومي المكون من 14 رقمًا.",
      "error"
    );
    return;
  }

  const button = $("studentLogin");
  button.disabled = true;
  button.textContent = "جاري تسجيل الدخول...";

  try {
    const { error } = await studentSignInWithPassword({
      email: studentEmail(code),
      password: nationalId
    });

    if (error) throw error;

  } catch (error) {
    console.error("Student login error:", error);

    msg(
      "loginMsg",
      "بيانات الدخول غير صحيحة أو الحساب غير نشط.",
      "error"
    );

  } finally {
    button.disabled = false;
    button.textContent = "دخول";
  }
};

// =====================================
// تسجيل الخروج
// =====================================

$("logout").onclick = async () => {
  try {
    if (scanner && scanning) {
      await scanner.stop();
      scanning = false;
    }

    await studentSignOut();
    setView(false);

  } catch (error) {
    console.error("Logout error:", error);

    msg(
      "resultMsg",
      "تعذر تسجيل الخروج بشكل كامل.",
      "error"
    );
  }
};

// =====================================
// مسح QR وتسجيل الحضور
// =====================================

$("scanBtn").onclick = async () => {
  if (processingQR) return;

  const {
    data: { user },
    error
  } = await studentAuth.getUser();

  if (error || !user) {
    msg("resultMsg", "سجّل الدخول أولاً.", "error");
    return;
  }

  if (typeof Html5Qrcode === "undefined") {
    msg(
      "resultMsg",
      "تعذر تحميل قارئ QR. تحقق من اتصال الإنترنت.",
      "error"
    );
    return;
  }

  if (scanning) {
    try {
      await scanner.stop();
      scanning = false;
      $("scanBtn").textContent = "فتح الكاميرا ومسح QR";

    } catch (error) {
      console.error("Scanner stop error:", error);
      msg("resultMsg", "تعذر إيقاف الكاميرا.", "error");
    }
    return;
  }

  scanner = new Html5Qrcode("reader");

  try {
    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: { width: 240, height: 240 }
      },

      async (decoded) => {
        if (!scanning || processingQR) return;

        processingQR = true;
        scanning = false;

        try {
          await scanner.stop();
        } catch (error) {
          console.warn("Scanner stop:", error);
        }

        $("scanBtn").textContent = "فتح الكاميرا ومسح QR";

        try {
          const payload = JSON.parse(decoded);

          if (!payload.sessionId || !payload.token) {
            throw new Error("رمز QR غير مفهوم.");
          }

          const result = await callStudent("markAttendance", {
            sessionId: payload.sessionId,
            token: payload.token
          });

          const attendance = result.data;

          msg(
            "resultMsg",
            `تم تسجيل حضور ${attendance.studentName} في ${attendance.sessionTitle} بنجاح.`,
            "success-note"
          );

        } catch (error) {
          console.error("Attendance error:", error);

          const errorMessage =
            error.message || "تعذر تسجيل الحضور.";

          msg(
            "resultMsg",
            errorMessage.includes("سبق")
              ? "تم تسجيل حضورك بالفعل."
              : errorMessage,
            "error"
          );

        } finally {
          processingQR = false;
        }
      }
    );

    scanning = true;
    $("scanBtn").textContent = "إيقاف الكاميرا";

    msg(
      "resultMsg",
      "وجّه الكاميرا نحو رمز QR الخاص بالمحاضرة."
    );

  } catch (error) {
    console.error("Camera error:", error);
    scanning = false;

    msg(
      "resultMsg",
      "تعذر تشغيل الكاميرا. اسمح للموقع باستخدام الكاميرا وتأكد من استخدام HTTPS.",
      "error"
    );
  }
};
