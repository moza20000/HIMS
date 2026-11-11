
import {
  supabase,
  auth,
  signInWithPassword,
  signOut,
  onAuthStateChanged,
  call
} from "./supabase.js";

const $ = id => document.getElementById(id);

let students = [];
let sessions = [];
let attendance = [];
let auditLogs = [];

let currentSession = null;
let subscriptions = [];
let showArchivedStudents = false;

const show = (id, yes = true) =>
  $(id).style.display = yes ? "" : "none";

const modal = (id, yes = true) =>
  $(id).classList.toggle("open", yes);

const esc = s =>
  String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const dateText = n =>
  n ? new Date(n).toLocaleString("ar-EG") : "—";

const errText = e =>
  e?.message || "حدث خطأ غير متوقع.";

// =====================================
// تسجيل الدخول والتحقق من الإدارة
// =====================================

onAuthStateChanged(async user => {
  cleanupSubscriptions();

  if (!user) {
    show("loginView");
    show("appView", false);
    $("adminEmail").textContent = "";
    return;
  }

  let profileResult;

  try {
    profileResult = await supabase
      .from("profiles")
      .select("id,name,role,active")
      .eq("id", user.id)
      .maybeSingle();

  } catch (e) {
    console.error("MOZA profile lookup threw:", e);
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">تعذر فحص صلاحيات الحساب: ${esc(errText(e))}</div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  const { data: profile, error } = profileResult || {};

  if (error) {
    console.error("MOZA profile lookup failed:", error);
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        قاعدة البيانات رفضت قراءة صلاحيات الحساب:
        ${esc(errText(error))}
        <br>
        تأكد أن الموقع متصل بمشروع Supabase الصحيح.
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  if (!profile) {
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        تم تسجيل الدخول، لكن لا يوجد سجل لهذا الحساب في جدول profiles.
        لا تحذف الحساب؛ نحتاج إصلاح سجل الصلاحيات.
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  if (!["owner", "admin"].includes(profile.role)) {
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        تم العثور على الحساب، لكن الدور الحالي هو
        (${esc(profile.role)}). المطلوب owner أو admin.
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  if (profile.active !== true) {
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        حساب الإدارة موجود لكنه غير نشط (active = false).
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  $("adminEmail").textContent = user.email || "";

  show("loginView", false);
  show("appView");

  subscribeData();
});

// =====================================
// تسجيل الدخول والخروج
// =====================================

$("adminLogin").onclick = async () => {
  $("loginMsg").innerHTML = "";

  try {
    const { error } = await signInWithPassword({
      email: $("adminEmailInput").value.trim(),
      password: $("adminPassword").value
    });

    if (error) throw error;

  } catch (e) {
    $("loginMsg").innerHTML =
      `<div class="notice error">${esc(errText(e))}</div>`;
  }
};

$("logoutBtn").onclick = () => signOut();

// =====================================
// تحميل البيانات والاشتراكات
// =====================================

function cleanupSubscriptions() {
  subscriptions.forEach(c => supabase.removeChannel(c));
  subscriptions = [];
}

async function loadTable(tableName, assign, render) {
  const { data, error } = await supabase
    .from(tableName)
    .select("*");

  if (error) {
    console.error(tableName, error);
    return;
  }

  assign(data || []);
  render();
}

function subscribeData() {
  const refresh = () => Promise.all([
    loadTable(
      "profiles",
      v => students = v.filter(x => x.role === "student"),
      () => {
        renderStudents();
        renderDashboard();
      }
    ),

    loadTable(
      "sessions",
      v => sessions = v,
      () => {
        renderSessions();
        renderDashboard();
        fillSessionFilter();
      }
    ),

    loadTable(
      "attendance",
      v => attendance = v,
      () => {
        renderAttendance();
        renderDashboard();

        $("reportSummary").textContent =
          `إجمالي سجلات الحضور: ${allRecords().length}`;
      }
    ),

    loadTable(
      "audit_logs",
      v => auditLogs = v,
      renderAudit
    )
  ]);

  refresh();

  for (const tableName of [
    "profiles",
    "sessions",
    "attendance",
    "audit_logs"
  ]) {
    const channel = supabase
      .channel("admin-" + tableName + "-" + Math.random())
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: tableName
        },
        refresh
      )
      .subscribe();

    subscriptions.push(channel);
  }
}

function allRecords() {
  return attendance;
}

// =====================================
// لوحة التحكم
// =====================================

function renderDashboard() {
  const studentList = students.filter(s => !s.archived_at);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const todayRows = allRecords().filter(r =>
    new Date(r.timestamp).getTime() >= today.getTime()
  );

  $("totalStudents").textContent = studentList.length;
  $("todayPresent").textContent = todayRows.length;

  $("todayAbsent").textContent = Math.max(
    0,
    studentList.filter(s => s.active).length - todayRows.length
  );

  $("totalSessions").textContent = sessions.length;

  const recent = [...allRecords()]
    .sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    )
    .slice(0, 8);

  $("recentAttendance").innerHTML = recent.length
    ? table(
        ["الطالب", "الكود", "المحاضرة", "الوقت"],
        recent.map(r => [
          esc(r.student_name),
          esc(r.student_code),
          esc(r.session_title),
          dateText(r.timestamp)
        ])
      )
    : '<div class="empty">لا توجد سجلات حضور بعد.</div>';
}

// =====================================
// إنشاء الجداول
// =====================================

function table(headers, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            ${headers.map(h => `<th>${h}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>
              ${row.map(c => `<td>${c}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// =====================================
// عرض الطلاب والحذف والاستعادة
// =====================================

function renderStudents() {
  const q = ($("studentSearch")?.value || "").toLowerCase();

  const list = students
    .filter(s =>
      showArchivedStudents
        ? !!s.archived_at
        : !s.archived_at
    )
    .filter(s =>
      `${s.name} ${s.code} ${s.branch || ""}`.toLowerCase().includes(q)
    )
    .sort((a, b) =>
      a.name.localeCompare(b.name, "ar")
    );

  $("studentCount").textContent =
    `${list.length} طالب`;

  $("studentsTable").innerHTML = list.length
    ? table(
        ["الاسم", "الكود", "الشعبة", "الحالة", "تاريخ الإضافة", "الإجراءات"],

        list.map(s => [
          esc(s.name),
          esc(s.code),
          esc(s.branch || "غير محددة"),

          s.archived_at
            ? '<span class="pill red">مؤرشف</span>'
            : s.active
              ? '<span class="pill green">نشط</span>'
              : '<span class="pill red">موقوف</span>',

          dateText(s.created_at),

          s.archived_at
            ? `
              <button class="btn small success" data-restore="${s.id}">
                استعادة
              </button>

              <button class="btn small danger" data-delete="${s.id}">
                حذف نهائي
              </button>
            `
            : `
              <button class="btn small secondary" data-edit="${s.id}">
                تعديل
              </button>

              <button
                class="btn small ${s.active ? "danger" : "success"}"
                data-toggle="${s.id}"
                data-active="${!s.active}">
                ${s.active ? "إيقاف" : "تفعيل"}
              </button>

              <button class="btn small secondary" data-archive="${s.id}">
                حذف آمن
              </button>

              <button class="btn small danger" data-delete="${s.id}">
                حذف نهائي
              </button>
            `
        ])
      )
    : '<div class="empty">لا يوجد طلاب مطابقون.</div>';

  $("studentsTable")
    .querySelectorAll("[data-edit]")
    .forEach(b => {
      b.onclick = () => editStudent(b.dataset.edit);
    });

  $("studentsTable")
    .querySelectorAll("[data-toggle]")
    .forEach(b => {
      b.onclick = async () => {
        if (!confirm("هل تريد تغيير حالة حساب الطالب؟")) return;

        try {
          await call("setStudentActive", {
            uid: b.dataset.toggle,
            active: b.dataset.active === "true"
          });
        } catch (e) {
          alert(errText(e));
        }
      };
    });

  $("studentsTable")
    .querySelectorAll("[data-archive]")
    .forEach(b => {
      b.onclick = async () => {
        if (!confirm(
          "سيتم إخفاء الطالب وإيقاف حسابه مع الاحتفاظ بسجلات الحضور. هل تريد المتابعة؟"
        )) return;

        try {
          await call("archiveStudent", {
            uid: b.dataset.archive
          });

          alert("تمت أرشفة الطالب بنجاح.");

        } catch (e) {
          alert("تعذرت أرشفة الطالب: " + errText(e));
        }
      };
    });

  $("studentsTable")
    .querySelectorAll("[data-restore]")
    .forEach(b => {
      b.onclick = async () => {
        if (!confirm("هل تريد استعادة الطالب وتفعيل حسابه؟")) return;

        try {
          await call("restoreStudent", {
            uid: b.dataset.restore
          });

          alert("تمت استعادة الطالب بنجاح.");

        } catch (e) {
          alert("تعذرت استعادة الطالب: " + errText(e));
        }
      };
    });

  $("studentsTable")
    .querySelectorAll("[data-delete]")
    .forEach(b => {
      b.onclick = async () => {
        if (!confirm(
          "تحذير: سيتم حذف حساب الطالب وجميع سجلات حضوره نهائيًا. هذا الإجراء لا يمكن التراجع عنه. هل أنت متأكد؟"
        )) return;

        if (!confirm(
          "تأكيد أخير: هل تريد الحذف النهائي بالفعل؟"
        )) return;

        try {
          await call("deleteStudent", {
            uid: b.dataset.delete
          });

          alert("تم حذف الطالب وسجلات حضوره نهائيًا.");

        } catch (e) {
          alert("تعذر الحذف: " + errText(e));
        }
      };
    });
}

// =====================================
// البحث وعرض الطلاب المؤرشفين
// =====================================

$("studentSearch").oninput = renderStudents;

const archivedBtn = document.createElement("button");

archivedBtn.className = "btn secondary";
archivedBtn.textContent = "عرض الطلاب المؤرشفين";

$("studentSearch").parentElement.appendChild(archivedBtn);

archivedBtn.onclick = () => {
  showArchivedStudents = !showArchivedStudents;

  archivedBtn.textContent = showArchivedStudents
    ? "العودة للطلاب الحاليين"
    : "عرض الطلاب المؤرشفين";

  $("studentSearch").value = "";
  renderStudents();
};

// =====================================
// إضافة طالب جديد
// =====================================

$("addStudentBtn").onclick = () => {
  $("studentForm").reset();

  $("editUid").value = "";
  $("studentCode").disabled = false;

  $("studentBranch").value = "";

  $("nationalIdField").style.display = "";
  $("studentNationalId").required = true;

  $("studentModalTitle").textContent = "إضافة طالب";
  $("studentFormMsg").innerHTML = "";

  modal("studentModal");
};

// =====================================
// تعديل طالب
// =====================================

function editStudent(uid) {
  const s = students.find(x => x.id === uid);

  if (!s) return;

  $("studentForm").reset();

  $("editUid").value = uid;
  $("studentName").value = s.name;
  $("studentCode").value = s.code;
  $("studentBranch").value = s.branch || "";

  $("studentCode").disabled = true;

  $("nationalIdField").style.display = "none";
  $("studentNationalId").required = false;

  $("studentModalTitle").textContent =
    "تعديل بيانات الطالب";

  $("studentFormMsg").innerHTML = "";

  modal("studentModal");
}

// =====================================
// حفظ بيانات الطالب والشعبة
// =====================================

$("studentForm").onsubmit = async e => {
  e.preventDefault();

  $("studentFormMsg").innerHTML = "";

  try {
    const uid = $("editUid").value;
    const name = $("studentName").value.trim();
    const branch = $("studentBranch").value;

    if (!["شعبة عامة", "شعبة نظم"].includes(branch)) {
      throw new Error("اختر شعبة الطالب.");
    }

    if (uid) {
      await call("updateStudent", {
        uid,
        name,
        branch
      });

    } else {
      await call("createStudent", {
        name,
        code: $("studentCode").value.trim(),
        nationalId: $("studentNationalId").value.trim(),
        branch
      });
    }

    modal("studentModal", false);
    $("studentForm").reset();

  } catch (err) {
    $("studentFormMsg").innerHTML =
      `<div class="notice error">${esc(errText(err))}</div>`;
  }
};

// =====================================
// إنشاء محاضرة
// =====================================

$("newSessionBtn").onclick = () =>
  modal("sessionModal");

$("sessionForm").onsubmit = async e => {
  e.preventDefault();

  $("sessionMsg").innerHTML = "";

  try {
    const result = await call("createSession", {
      title: $("sessionTitle").value.trim(),
      durationMinutes: Number($("sessionDuration").value)
    });

    currentSession = result.data;

    modal("sessionModal", false);
    renderActiveQR();

  } catch (err) {
    $("sessionMsg").innerHTML =
      `<div class="notice error">${esc(errText(err))}</div>`;
  }
};

// =====================================
// عرض QR
// =====================================

function renderActiveQR() {
  if (!currentSession) return;

  const payload = JSON.stringify({
    sessionId: currentSession.id,
    token: currentSession.token
  });

  $("activeQr").innerHTML = `
    <div style="text-align:center">
      <span class="pill green">جلسة نشطة</span>
      <h3>${esc(currentSession.title)}</h3>

      <div id="qrBox">
        <div id="qrCanvas"></div>
      </div>

      <p class="muted">
        صالح حتى: ${dateText(currentSession.expiresAt)}
      </p>

      <button id="endCurrentSession" class="btn danger">
        إنهاء الجلسة
      </button>
    </div>
  `;

  new QRCode($("qrCanvas"), {
    text: payload,
    width: 220,
    height: 220,
    colorDark: "#06152c",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.H
  });

  $("endCurrentSession").onclick = async () => {
    try {
      await call("endSession", {
        sessionId: currentSession.id
      });

      currentSession = null;

      $("activeQr").innerHTML =
        '<div class="empty">تم إنهاء الجلسة.</div>';

    } catch (e) {
      alert(errText(e));
    }
  };
}

// =====================================
// عرض المحاضرات مع زر الحذف
// =====================================

function renderSessions() {
  const list = [...sessions].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  $("sessionsTable").innerHTML = list.length
    ? table(
        ["المحاضرة", "تاريخ الإنشاء", "الصلاحية", "الحالة", "الإجراءات"],

        list.map(s => [
          esc(s.title),
          dateText(s.created_at),
          dateText(s.expires_at),

          s.active &&
          Date.now() < new Date(s.expires_at).getTime()
            ? '<span class="pill green">نشطة</span>'
            : '<span class="pill red">منتهية</span>',

          `<button
             class="btn small danger"
             data-delete-session="${esc(s.id)}">
             حذف المحاضرة
           </button>`
        ])
      )
    : '<div class="empty">لا توجد محاضرات.</div>';

  $("sessionsTable")
    .querySelectorAll("[data-delete-session]")
    .forEach(button => {
      button.onclick = async () => {
        const sessionId = button.dataset.deleteSession;
        const session = sessions.find(s => s.id === sessionId);

        if (!session) {
          alert("المحاضرة غير موجودة.");
          return;
        }

        if (!confirm(
          `هل أنت متأكد من حذف المحاضرة "${session.title}"؟\n\nسيتم حذف سجلات الحضور المرتبطة بها أيضًا، ولا يمكن التراجع عن ذلك.`
        )) return;

        button.disabled = true;
        button.textContent = "جارٍ الحذف...";

        try {
          await call("deleteSession", { sessionId });

          sessions = sessions.filter(s => s.id !== sessionId);

          attendance = attendance.filter(
            r => r.session_id !== sessionId
          );

          if (currentSession?.id === sessionId) {
            currentSession = null;

            $("activeQr").innerHTML =
              '<div class="empty">تم حذف المحاضرة.</div>';
          }

          renderSessions();
          renderAttendance();
          renderDashboard();
          fillSessionFilter();

          $("reportSummary").textContent =
            `إجمالي سجلات الحضور: ${allRecords().length}`;

          alert("تم حذف المحاضرة وسجلات حضورها بنجاح.");

        } catch (e) {
          alert("تعذر حذف المحاضرة: " + errText(e));

          button.disabled = false;
          button.textContent = "حذف المحاضرة";
        }
      };
    });
}

// =====================================
// فلتر المحاضرات
// =====================================

function fillSessionFilter() {
  const select = $("attendanceSession");
  const old = select.value;

  select.innerHTML =
    '<option value="">كل المحاضرات</option>' +
    sessions.map(s =>
      `<option value="${esc(s.id)}">${esc(s.title)}</option>`
    ).join("");

  select.value = sessions.some(s => s.id === old) ? old : "";
}

// =====================================
// عرض الحضور
// =====================================

function renderAttendance() {
  const selected =
    $("attendanceSession")?.value || "";

  const q =
    ($("attendanceSearch")?.value || "").toLowerCase();

  const rows = allRecords()
    .filter(r =>
      (!selected || r.session_id === selected) &&
      `${r.student_name} ${r.student_code} ${r.session_title}`
        .toLowerCase()
        .includes(q)
    )
    .sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );

  $("attendanceTable").innerHTML = rows.length
    ? table(
        ["الطالب", "الكود", "المحاضرة", "الحالة", "وقت التسجيل"],

        rows.map(r => [
          esc(r.student_name),
          esc(r.student_code),
          esc(r.session_title),
          '<span class="pill green">حاضر</span>',
          dateText(r.timestamp)
        ])
      )
    : '<div class="empty">لا توجد سجلات مطابقة.</div>';
}

$("attendanceSession").onchange = renderAttendance;
$("attendanceSearch").oninput = renderAttendance;

// =====================================
// تصدير Excel
// =====================================

$("exportExcel").onclick = () => {
  const rows = allRecords().map(r => ({
    "اسم الطالب": r.student_name,
    "كود الطالب": r.student_code,
    "المحاضرة": r.session_title,
    "الحالة": "حاضر",
    "التاريخ": dateText(r.timestamp)
  }));

  if (!rows.length) {
    alert("لا توجد بيانات للتصدير.");
    return;
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    ws,
    "Attendance"
  );

  XLSX.writeFile(
    wb,
    `MOZA-Attendance-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
};

// =====================================
// سجل العمليات
// =====================================

function renderAudit() {
  const rows = [...auditLogs]
    .sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    )
    .slice(0, 200);

  $("auditTable").innerHTML = rows.length
    ? table(
        ["العملية", "المدير", "التفاصيل", "التوقيت"],

        rows.map(a => [
          esc(a.action),
          esc(a.admin_uid),
          esc(JSON.stringify(a.details || {})),
          dateText(a.created_at)
        ])
      )
    : '<div class="empty">لا توجد عمليات مسجلة.</div>';
}

// =====================================
// التنقل بين صفحات الإدارة
// =====================================

document.querySelectorAll("[data-tab]").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach(x =>
      x.classList.toggle("active", x === b)
    );

    document.querySelectorAll("main section").forEach(s => {
      s.hidden = s.id !== `tab-${b.dataset.tab}`;
    });
  };
});

// =====================================
// إغلاق النوافذ المنبثقة
// =====================================

document.querySelectorAll("[data-close]").forEach(b => {
  b.onclick = () =>
    modal(b.dataset.close, false);
});

document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", e => {
    if (e.target === m) {
      modal(m.id, false);
    }
  });
});
