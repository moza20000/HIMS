
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

const show = (id, yes = true) => {
  const el = $(id);
  if (el) el.style.display = yes ? "" : "none";
};

const modal = (id, yes = true) => {
  const el = $(id);
  if (el) el.classList.toggle("open", yes);
};

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
// توحيد أسماء المواد للمقارنة
// =====================================

function normalizeSubject(value) {
  return String(value || "غير محددة")
    .trim()
    .replace(/ـ/g, "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

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
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  if (!["owner", "admin"].includes(profile.role)) {
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        الدور الحالي غير مسموح له بدخول لوحة الإدارة.
      </div>`;

    show("loginView");
    show("appView", false);
    return;
  }

  if (profile.active !== true) {
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">
        حساب الإدارة غير نشط.
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
  let refreshing = false;

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;

    try {
      await Promise.all([
        loadTable(
          "profiles",
          v => students = v.filter(x => x.role === "student"),
          () => {
            renderStudents();
            renderDashboard();
            renderManualStudentResults();
          }
        ),

        loadTable(
          "sessions",
          v => sessions = v,
          () => {
            renderSessions();
            renderDashboard();
            fillSessionFilter();
            fillManualAttendanceOptions();
            renderStudents();
          }
        ),

        loadTable(
          "attendance",
          v => attendance = v,
          () => {
            renderAttendance();
            renderDashboard();
            renderStudents();

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
    } finally {
      refreshing = false;
    }
  };

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

  const todaySessions = sessions.filter(session =>
    new Date(session.created_at).getTime() >= today.getTime()
  );

  const todaySessionIds = new Set(
    todaySessions.map(session => session.id)
  );

  const todayRows = allRecords().filter(record =>
    todaySessionIds.has(record.session_id)
  );

  const eligibleToday = studentList
    .filter(student => student.active && !student.archived_at)
    .reduce(
      (sum, student) =>
        sum + studentAttendanceStats(student, todaySessions).total,
      0
    );

  const presentToday = new Set(
    todayRows.map(record =>
      `${record.student_id}:${record.session_id}`
    )
  ).size;

  $("totalStudents").textContent = studentList.length;
  $("todayPresent").textContent = presentToday;

  $("todayAbsent").textContent =
    Math.max(0, eligibleToday - presentToday);

  $("totalSessions").textContent = sessions.length;

  const recent = [...allRecords()]
    .sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    )
    .slice(0, 8);

  $("recentAttendance").innerHTML = recent.length
    ? table(
        ["الطالب", "الكود", "المحاضرة", "طريقة التسجيل", "الوقت"],
        recent.map(r => [
          esc(r.student_name),
          esc(r.student_code),
          esc(r.session_title),
          attendanceSourceText(r.source),
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
// مصدر تسجيل الحضور
// =====================================

function attendanceSourceText(source) {
  if (source === "manual") {
    return '<span class="pill" style="background:#164e36;color:#bbf7d0">يدوي</span>';
  }

  return '<span class="pill">QR</span>';
}

// =====================================
// حساب حضور الطالب حسب المادة
// =====================================

function studentAttendanceStats(student, sessionList = sessions) {
  const enrolledAt = student.created_at
    ? new Date(student.created_at).getTime()
    : 0;

  const eligible = sessionList.filter(session =>
    !session.created_at ||
    new Date(session.created_at).getTime() >= enrolledAt
  );

  const groups = new Map();

  eligible.forEach(session => {
    const key = normalizeSubject(session.subject);

    if (!groups.has(key)) {
      groups.set(key, {
        subject: session.subject || "غير محددة",
        sessions: []
      });
    }

    groups.get(key).sessions.push(session);
  });

  const bySubject = [];

  groups.forEach(group => {
    const ids = new Set(
      group.sessions.map(s => String(s.id))
    );

    const attendedIds = new Set(
      attendance
        .filter(record =>
          (
            String(record.student_id) === String(student.id) ||
            (
              !record.student_id &&
              record.student_code === student.code
            )
          ) &&
          ids.has(String(record.session_id))
        )
        .map(record => String(record.session_id))
    );

    const total = group.sessions.length;
    const attended = attendedIds.size;
    const absent = Math.max(0, total - attended);

    bySubject.push({
      subject: group.subject,
      total,
      attended,
      absent,
      percentage: total
        ? Math.round(attended / total * 100)
        : 0
    });
  });

  const attended = bySubject.reduce(
    (sum, item) => sum + item.attended,
    0
  );

  const absent = bySubject.reduce(
    (sum, item) => sum + item.absent,
    0
  );

  return {
    attended,
    absent,
    total: attended + absent,
    bySubject
  };
}

// =====================================
// عرض الطلاب
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
      `${s.name} ${s.code} ${s.branch || ""}`
        .toLowerCase()
        .includes(q)
    )
    .sort((a, b) =>
      a.name.localeCompare(b.name, "ar")
    );

  $("studentCount").textContent = `${list.length} طالب`;

  $("studentsTable").innerHTML = list.length
    ? table(
        [
          "الاسم",
          "الكود",
          "الشعبة",
          "حضر",
          "غاب",
          "نسبة الحضور",
          "تفاصيل المواد",
          "الحالة",
          "تاريخ الإضافة",
          "الإجراءات"
        ],

        list.map(s => {
          const stats = studentAttendanceStats(s);

          const percentage = stats.total
            ? Math.round(stats.attended / stats.total * 100)
            : 0;

          const subjectDetails = stats.bySubject.length
            ? stats.bySubject.map(item => `
                <div style="
                  padding:8px;
                  margin:4px 0;
                  border:1px solid #334155;
                  border-radius:8px;
                  min-width:170px;
                ">
                  <strong>${esc(item.subject)}</strong>

                  <div style="font-size:12px;margin-top:5px">
                    <span class="pill green">
                      حضر ${item.attended}
                    </span>

                    <span class="pill red">
                      غاب ${item.absent}
                    </span>

                    <span class="pill">
                      ${item.percentage}%
                    </span>
                  </div>
                </div>
              `).join("")
            : "لا توجد محاضرات";

          return [
            esc(s.name),
            esc(s.code),
            esc(s.branch || "غير محددة"),

            `<span class="pill green">${stats.attended}</span>`,

            `<span class="pill red">${stats.absent}</span>`,

            `<span class="pill">${percentage}%</span>`,

            `<div>${subjectDetails}</div>`,

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
          ];
        })
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
          "تحذير: سيتم حذف حساب الطالب وجميع سجلات حضوره نهائيًا. هل أنت متأكد؟"
        )) return;

        if (!confirm("تأكيد أخير: هل تريد الحذف النهائي بالفعل؟")) return;

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
// إضافة طالب
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

  $("studentModalTitle").textContent = "تعديل بيانات الطالب";
  $("studentFormMsg").innerHTML = "";

  modal("studentModal");
}

// =====================================
// حفظ بيانات الطالب
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
      subject: $("sessionSubject").value.trim(),
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
// عرض المواد والمحاضرات المجمعة
// =====================================

function renderSessions() {
  const list = [...sessions].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );

  const groups = new Map();

  list.forEach(session => {
    const key = normalizeSubject(session.subject);

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(session);
  });

  $("sessionsTable").innerHTML = groups.size
    ? table(
        [
          "المادة",
          "عدد المحاضرات",
          "آخر محاضرة",
          "آخر إنشاء",
          "الحالة",
          "الإجراءات"
        ],

        [...groups.values()].map(group => {
          const latest = group[0];

          const active = group.some(s =>
            s.active &&
            Date.now() < new Date(s.expires_at).getTime()
          );

          return [
            esc(latest.subject || "غير محددة"),

            `<span class="pill">${group.length} محاضرة</span>`,

            esc(latest.title),

            dateText(latest.created_at),

            active
              ? '<span class="pill green">نشطة</span>'
              : '<span class="pill red">منتهية</span>',

            group.map(s => `
              <button
                class="btn small danger"
                data-delete-session="${esc(s.id)}">
                حذف ${dateText(s.created_at)}
              </button>
            `).join(" ")
          ];
        })
      )
    : '<div class="empty">لا توجد محاضرات.</div>';

  $("sessionsTable")
    .querySelectorAll("[data-delete-session]")
    .forEach(button => {
      button.onclick = async () => {
        const sessionId = button.dataset.deleteSession;

        const session = sessions.find(s =>
          String(s.id) === String(sessionId)
        );

        if (!session) {
          alert("المحاضرة غير موجودة.");
          return;
        }

        if (!confirm(
          `هل تريد حذف المحاضرة "${session.title}"؟\nسيتم حذف سجلات حضورها أيضًا.`
        )) return;

        button.disabled = true;

        try {
          await call("deleteSession", { sessionId });

          sessions = sessions.filter(s =>
            String(s.id) !== String(sessionId)
          );

          attendance = attendance.filter(r =>
            String(r.session_id) !== String(sessionId)
          );

          if (
            currentSession &&
            String(currentSession.id) === String(sessionId)
          ) {
            currentSession = null;

            $("activeQr").innerHTML =
              '<div class="empty">تم حذف المحاضرة.</div>';
          }

          renderSessions();
          renderAttendance();
          renderDashboard();
          renderStudents();
          fillSessionFilter();
          fillManualAttendanceOptions();

          $("reportSummary").textContent =
            `إجمالي سجلات الحضور: ${allRecords().length}`;

          alert("تم حذف المحاضرة بنجاح.");

        } catch (e) {
          alert("تعذر حذف المحاضرة: " + errText(e));
          button.disabled = false;
        }
      };
    });
}

// =====================================
// فلتر المواد والمحاضرات
// =====================================

function fillSessionFilter() {
  const select = $("attendanceSession");
  const subjectSelect = $("attendanceSubject");

  const old = select.value;
  const oldSubject = subjectSelect?.value || "";

  if (subjectSelect) {
    const subjectMap = new Map();

    sessions.forEach(s => {
      const key = normalizeSubject(s.subject);

      if (!subjectMap.has(key)) {
        subjectMap.set(key, s.subject || "غير محددة");
      }
    });

    const subjects = [...subjectMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "ar"));

    subjectSelect.innerHTML =
      '<option value="">كل المواد</option>' +
      subjects.map(([key, subject]) =>
        `<option value="${esc(key)}">${esc(subject)}</option>`
      ).join("");

    subjectSelect.value =
      subjectMap.has(oldSubject)
        ? oldSubject
        : "";
  }

  const groups = [...new Map(
    sessions
      .filter(s =>
        !subjectSelect?.value ||
        normalizeSubject(s.subject) === subjectSelect.value
      )
      .map(s => {
        const key = String(s.id);

        return [
          key,
          {
            key,
            label: `${s.title} - ${dateText(s.created_at)}`
          }
        ];
      })
  ).values()];

  select.innerHTML =
    '<option value="">كل المحاضرات</option>' +
    groups.map(g =>
      `<option value="${esc(g.key)}">${esc(g.label)}</option>`
    ).join("");

  select.value = groups.some(g => g.key === old)
    ? old
    : "";
}

// =====================================
// تسجيل الحضور اليدوي
// =====================================

const manualSubjectSelect = $("manualAttendanceSubject");
const manualSessionSelect = $("manualAttendanceSession");
const manualSearchInput = $("manualStudentSearch");
const manualStudentUidInput = $("manualStudentUid");
const manualResults = $("manualStudentResults");
const manualSelectedBox = $("manualSelectedStudent");
const manualSubmitBtn = $("saveManualAttendanceBtn");
const manualMessage = $("manualAttendanceMsg");

// المواد المتاحة في نافذة الحضور اليدوي
function fillManualAttendanceOptions() {
  if (!manualSubjectSelect || !manualSessionSelect) return;

  const oldSubject = manualSubjectSelect.value;
  const oldSession = manualSessionSelect.value;

  const subjectMap = new Map();

  sessions.forEach(session => {
    const key = normalizeSubject(session.subject);

    if (!subjectMap.has(key)) {
      subjectMap.set(key, session.subject || "غير محددة");
    }
  });

  const subjects = [...subjectMap.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "ar"));

  manualSubjectSelect.innerHTML =
    '<option value="">اختر المادة</option>' +
    subjects.map(([key, subject]) =>
      `<option value="${esc(key)}">${esc(subject)}</option>`
    ).join("");

  manualSubjectSelect.value =
    subjectMap.has(oldSubject) ? oldSubject : "";

  fillManualSessionOptions(oldSession);
}

// المحاضرات التابعة للمادة المختارة
function fillManualSessionOptions(oldSession = "") {
  if (!manualSessionSelect) return;

  const selectedSubject = manualSubjectSelect.value;

  const filtered = sessions
    .filter(session =>
      selectedSubject &&
      normalizeSubject(session.subject) === selectedSubject
    )
    .sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );

  manualSessionSelect.innerHTML =
    '<option value="">اختر المحاضرة</option>' +
    filtered.map(session => `
      <option value="${esc(session.id)}">
        ${esc(session.title)} — ${esc(dateText(session.created_at))}
      </option>
    `).join("");

  manualSessionSelect.disabled = filtered.length === 0;

  if (filtered.some(s => String(s.id) === String(oldSession))) {
    manualSessionSelect.value = oldSession;
  }
}

// تصفير اختيار الطالب
function clearManualStudent() {
  manualStudentUidInput.value = "";
  manualSelectedBox.hidden = true;
  manualSelectedBox.innerHTML = "";
  manualSubmitBtn.disabled = true;
}

// إظهار نتائج البحث عن الطلاب
function renderManualStudentResults() {
  if (!manualResults || !manualSearchInput) return;

  const query = manualSearchInput.value
    .trim()
    .toLowerCase();

  clearManualStudent();

  if (!query) {
    manualResults.hidden = true;
    manualResults.innerHTML = "";
    return;
  }

  const matches = students
    .filter(student =>
      student.role === "student" &&
      student.active === true &&
      !student.archived_at
    )
    .filter(student =>
      `${student.name || ""} ${student.code || ""}`
        .toLowerCase()
        .includes(query)
    )
    .sort((a, b) =>
      String(a.name || "").localeCompare(
        String(b.name || ""),
        "ar"
      )
    )
    .slice(0, 30);

  if (!matches.length) {
    manualResults.hidden = false;
    manualResults.innerHTML =
      '<div class="empty">لا يوجد طالب نشط مطابق للبحث.</div>';
    return;
  }

  manualResults.hidden = false;

  manualResults.innerHTML = matches.map(student => `
    <button
      type="button"
      class="manual-student-item"
      data-manual-student="${esc(student.id)}"
    >
      <span>
        <strong>${esc(student.name)}</strong>
        <small style="display:block;color:#94a3b8;margin-top:4px">
          كود الطالب: ${esc(student.code)}
        </small>
      </span>

      <span class="pill green">نشط</span>
    </button>
  `).join("");

  manualResults
    .querySelectorAll("[data-manual-student]")
    .forEach(button => {
      button.onclick = () => {
        const student = students.find(s =>
          String(s.id) === String(button.dataset.manualStudent)
        );

        if (!student || student.active !== true || student.archived_at) {
          alert("هذا الطالب غير نشط أو غير متاح للتسجيل.");
          return;
        }

        selectManualStudent(student);
      };
    });
}

// اعتماد الطالب المختار
function selectManualStudent(student) {
  manualStudentUidInput.value = student.id;

  manualSelectedBox.hidden = false;
  manualSelectedBox.innerHTML = `
    <strong>الطالب المختار</strong>
    <div style="margin-top:6px">${esc(student.name)}</div>
    <div class="muted" style="font-size:12px">
      كود الطالب: ${esc(student.code)}
    </div>
  `;

  manualResults.hidden = true;
  manualResults.innerHTML = "";

  manualSubmitBtn.disabled = false;
}

// فتح نافذة الحضور اليدوي
$("openManualAttendanceBtn").onclick = () => {
  $("manualAttendanceForm").reset();

  manualMessage.innerHTML = "";
  manualSearchInput.value = "";

  clearManualStudent();

  manualResults.hidden = true;
  manualResults.innerHTML = "";

  fillManualAttendanceOptions();

  manualSubjectSelect.value = "";
  manualSessionSelect.innerHTML =
    '<option value="">اختر المادة أولاً</option>';
  manualSessionSelect.disabled = true;

  modal("manualAttendanceModal");
};

// تغيير المادة
manualSubjectSelect.onchange = () => {
  fillManualSessionOptions();

  manualSearchInput.value = "";
  manualResults.hidden = true;
  manualResults.innerHTML = "";

  clearManualStudent();
  manualMessage.innerHTML = "";
};

// تغيير المحاضرة
manualSessionSelect.onchange = () => {
  clearManualStudent();
  manualMessage.innerHTML = "";
};

// البحث عن الطالب
manualSearchInput.oninput = () => {
  manualMessage.innerHTML = "";
  renderManualStudentResults();
};

// تأكيد تسجيل الحضور اليدوي
$("manualAttendanceForm").onsubmit = async e => {
  e.preventDefault();

  manualMessage.innerHTML = "";

  const sessionId = manualSessionSelect.value;
  const studentUid = manualStudentUidInput.value;

  if (!sessionId) {
    manualMessage.innerHTML =
      '<div class="notice error">اختر المحاضرة أولاً.</div>';
    return;
  }

  if (!studentUid) {
    manualMessage.innerHTML =
      '<div class="notice error">ابحث عن الطالب واختره من النتائج.</div>';
    return;
  }

  const session = sessions.find(s =>
    String(s.id) === String(sessionId)
  );

  const student = students.find(s =>
    String(s.id) === String(studentUid)
  );

  if (!session) {
    manualMessage.innerHTML =
      '<div class="notice error">المحاضرة المختارة غير موجودة.</div>';
    return;
  }

  if (
    !student ||
    student.role !== "student" ||
    student.active !== true ||
    student.archived_at
  ) {
    manualMessage.innerHTML =
      '<div class="notice error">الطالب غير نشط أو غير متاح للتسجيل.</div>';
    return;
  }

  if (attendance.some(record =>
    String(record.session_id) === String(sessionId) &&
    (
      String(record.student_id) === String(studentUid) ||
      (
        !record.student_id &&
        String(record.student_code) === String(student.code)
      )
    )
  )) {
    manualMessage.innerHTML =
      '<div class="notice error">هذا الطالب مسجل حضوره بالفعل في هذه المحاضرة.</div>';
    return;
  }

  manualSubmitBtn.disabled = true;
  manualSubmitBtn.textContent = "جارٍ تسجيل الحضور...";

  try {
    const result = await call("manualAttendance", {
      sessionId,
      studentUid
    });

    if (result?.error) {
      throw result.error;
    }

    const response = result?.data ?? result;

    if (response?.ok === false) {
      throw new Error(
        response.message || response.error || "تعذر تسجيل الحضور."
      );
    }

    manualMessage.innerHTML =
      `<div class="notice success">
        ${esc(response?.message || "تم تسجيل حضور الطالب بنجاح.")}
      </div>`;

    // تحديث سجل الحضور مباشرة من قاعدة البيانات
    const attendanceResult = await supabase
      .from("attendance")
      .select("*");

    if (attendanceResult.error) {
      console.error(
        "Manual attendance refresh error:",
        attendanceResult.error
      );
    } else {
      attendance = attendanceResult.data || [];
      renderAttendance();
      renderDashboard();
      renderStudents();

      $("reportSummary").textContent =
        `إجمالي سجلات الحضور: ${allRecords().length}`;
    }

    // تحديث سجل العمليات
    const auditResult = await supabase
      .from("audit_logs")
      .select("*");

    if (!auditResult.error) {
      auditLogs = auditResult.data || [];
      renderAudit();
    }

    manualSearchInput.value = "";
    clearManualStudent();

  } catch (error) {
    console.error("Manual attendance error:", error);

    manualMessage.innerHTML =
      `<div class="notice error">${esc(errText(error))}</div>`;

  } finally {
    manualSubmitBtn.disabled = !manualStudentUidInput.value;
    manualSubmitBtn.textContent = "تأكيد تسجيل الحضور";
  }
};

// =====================================
// عرض الحضور
// =====================================

function renderAttendance() {
  const selected = $("attendanceSession")?.value || "";

  const q = ($("attendanceSearch")?.value || "")
    .toLowerCase();

  const selectedSubject = $("attendanceSubject")?.value || "";

  const rows = allRecords()
    .filter(r => {
      const session = sessions.find(s =>
        String(s.id) === String(r.session_id)
      );

      const matchesSubject =
        !selectedSubject ||
        (
          session &&
          normalizeSubject(session.subject) === selectedSubject
        );

      const matchesLecture =
        !selected ||
        String(r.session_id) === selected;

      return matchesSubject &&
        matchesLecture &&
        `${r.student_name} ${r.student_code} ${r.session_title}`
          .toLowerCase()
          .includes(q);
    })
    .sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );

  $("attendanceTable").innerHTML = rows.length
    ? table(
        [
          "الطالب",
          "الكود",
          "المادة",
          "المحاضرة",
          "الحالة",
          "طريقة التسجيل",
          "وقت التسجيل"
        ],

        rows.map(r => {
          const session = sessions.find(s =>
            String(s.id) === String(r.session_id)
          );

          return [
            esc(r.student_name),
            esc(r.student_code),
            esc(session?.subject || "غير محددة"),
            esc(r.session_title),
            '<span class="pill green">حاضر</span>',
            attendanceSourceText(r.source),
            dateText(r.timestamp)
          ];
        })
      )
    : '<div class="empty">لا توجد سجلات مطابقة.</div>';
}

$("attendanceSession").onchange = renderAttendance;

$("attendanceSubject").onchange = () => {
  fillSessionFilter();
  renderAttendance();
};

$("attendanceSearch").oninput = renderAttendance;

// =====================================
// تصدير Excel
// =====================================

$("exportExcel").onclick = () => {
  const rows = allRecords().map(r => {
    const session = sessions.find(s =>
      String(s.id) === String(r.session_id)
    );

    return {
      "اسم الطالب": r.student_name,
      "كود الطالب": r.student_code,
      "المادة": session?.subject || "غير محددة",
      "المحاضرة": r.session_title,
      "الحالة": "حاضر",
      "طريقة التسجيل": r.source === "manual" ? "يدوي" : "QR",
      "التاريخ": dateText(r.timestamp)
    };
  });

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
