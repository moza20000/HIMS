
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
let authCheckId = 0;

const DEFAULT_SCAN_TEXT = "فتح الكاميرا ومسح QR";

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
  if ($("loginView")) {
    $("loginView").style.display = loggedIn ? "none" : "grid";
  }

  if ($("studentView")) {
    $("studentView").style.display = loggedIn ? "block" : "none";
  }
}

function formatAcademicYear(year) {
  const years = {
    1: "الأولى",
    2: "الثانية",
    3: "الثالثة",
    4: "الرابعة"
  };

  return years[Number(year)] || "غير محددة";
}

function formatBranch(branch) {
  const branches = {
    general: "عامة",
    systems: "نظم",
    "عام": "عامة",
    "نظم": "نظم"
  };

  return branches[branch] || branch || "غير محددة";
}

function showStudentGroup(profile) {
  const year = formatAcademicYear(profile.academic_year);
  const branch = formatBranch(profile.branch);

  const element = $("welcomeBranch");

  if (element) {
    element.textContent =
      `الفرقة: ${year} | الشعبة: ${branch}`;
  }
}

async function stopScanner() {
  if (!scanner || !scanning) {
    scanning = false;
    return;
  }

  try {
    await scanner.stop();
  } catch (error) {
    console.warn("Scanner stop error:", error);
  }

  scanning = false;

  if ($("scanBtn")) {
    $("scanBtn").textContent = DEFAULT_SCAN_TEXT;
  }
}

async function showUser(user) {
  const currentCheck = ++authCheckId;

  if (!user) {
    await stopScanner();
    setView(false);
    return;
  }

  try {
    const { data: profile, error } = await studentSupabase
      .from("profiles")
      .select(
        "id,name,code,branch,academic_year,active,role,archived_at"
      )
      .eq("id", user.id)
      .maybeSingle();

    if (currentCheck !== authCheckId) return;

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
      profile.role !== "student" ||
      profile.archived_at
    ) {
      await studentSignOut();
      setView(false);

      msg(
        "loginMsg",
        "الحساب غير نشط أو مؤرشف أو غير مسجل كطالب.",
        "error"
      );

      return;
    }

    if (
      !profile.academic_year ||
      !profile.branch
    ) {
      await studentSignOut();
      setView(false);

      msg(
        "loginMsg",
        "بيانات الفرقة أو الشعبة غير مكتملة. تواصل مع الإدارة.",
        "error"
      );

      return;
    }

    if ($("welcomeName")) {
      $("welcomeName").textContent =
        `أهلاً ${profile.name || "بك"}`;
    }

    showStudentGroup(profile);

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

// =====================================
// متابعة حالة تسجيل الدخول
// =====================================

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
  const button = $("logout");

  button.disabled = true;

  try {
    await stopScanner();

    await studentSignOut();

    setView(false);

    if ($("studentCode")) {
      $("studentCode").value = "";
    }

    if ($("studentNationalId")) {
      $("studentNationalId").value = "";
    }

    if ($("resultMsg")) {
      $("resultMsg").innerHTML = "";
    }

  } catch (error) {
    console.error("Logout error:", error);

    msg(
      "resultMsg",
      "تعذر تسجيل الخروج بشكل كامل.",
      "error"
    );

  } finally {
    button.disabled = false;
  }
};

// =====================================
// مسح QR وتسجيل الحضور
// =====================================

$("scanBtn").onclick = async () => {
  if (processingQR) return;

  const button = $("scanBtn");

  try {
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

    // إيقاف الكاميرا
    if (scanning) {
      await stopScanner();

      msg("resultMsg", "تم إيقاف الكاميرا.");

      return;
    }

    scanner = new Html5Qrcode("reader");

    button.disabled = true;

    await scanner.start(
      { facingMode: "environment" },
      {
        fps: 10,
        qrbox: {
          width: 240,
          height: 240
        }
      },

      async (decoded) => {
        if (!scanning || processingQR) return;

        processingQR = true;

        await stopScanner();

        try {
          let payload;

          try {
            payload = JSON.parse(decoded);
          } catch {
            throw new Error("رمز QR غير صحيح.");
          }

          if (
            !payload ||
            typeof payload.sessionId !== "string" ||
            typeof payload.token !== "string" ||
            !payload.sessionId ||
            !payload.token
          ) {
            throw new Error("رمز QR غير مفهوم.");
          }

          msg(
            "resultMsg",
            "جاري التحقق من المحاضرة وتسجيل الحضور..."
          );

          const result = await callStudent(
            "markAttendance",
            {
              sessionId: payload.sessionId,
              token: payload.token
            }
          );

          if (result?.error) {
            throw result.error;
          }

          const attendance = result?.data ?? result;

          if (!attendance) {
            throw new Error("لم يتم استلام تأكيد تسجيل الحضور.");
          }

          const studentName =
            attendance.studentName || "الطالب";

          const sessionTitle =
            attendance.sessionTitle || "المحاضرة";

          msg(
            "resultMsg",
            `تم تسجيل حضور ${studentName} في ${sessionTitle} بنجاح.`,
            "success-note"
          );

        } catch (error) {
          console.error("Attendance error:", error);

          const errorMessage =
            error?.message || "تعذر تسجيل الحضور.";

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

    button.textContent = "إيقاف الكاميرا";

    msg(
      "resultMsg",
      "الكاميرا تعمل الآن. وجّهها نحو رمز QR الخاص بمحاضرتك."
    );

  } catch (error) {
    console.error("Camera error:", error);

    scanning = false;

    msg(
      "resultMsg",
      "تعذر تشغيل الكاميرا. اسمح للموقع باستخدام الكاميرا وتأكد من استخدام HTTPS.",
      "error"
    );

  } finally {
    button.disabled = false;
  }
};
