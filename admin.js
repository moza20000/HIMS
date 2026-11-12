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

let subscriptions = [];
let showArchivedStudents = false;
let refreshing = false;
let refreshAgain = false;

// رموز QR تحفظ في ذاكرة الصفحة فقط ولا تُسترجع من قاعدة البيانات.
const qrTokens = new Map();

const YEARS = [1, 2, 3, 4];
const BRANCHES = ["شعبة عامة", "شعبة نظم"];

const show = (id, yes = true) => {
  const el = $(id);
  if (el) el.style.display = yes ? "" : "none";
};

const modal = (id, yes = true) => {
  const el = $(id);
  if (el) el.classList.toggle("open", yes);
};

const esc = value =>
  String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));

const dateText = value =>
  value ? new Date(value).toLocaleString("ar-EG") : "—";

const errText = error =>
  error?.message || String(error || "حدث خطأ غير متوقع.");

const yearText = year => {
  const names = {
    1: "الفرقة الأولى",
    2: "الفرقة الثانية",
    3: "الفرقة الثالثة",
    4: "الفرقة الرابعة"
  };
  return names[Number(year)] || "فرقة غير محددة";
};

const cohortText = (year, branch) =>
  `${yearText(year)} - ${branch || "شعبة غير محددة"}`;

const normalizeSubject = value =>
  String(value || "غير محددة")
    .trim()
    .replace(/ـ/g, "")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();

const getResponse = result => {
  if (result?.error) throw result.error;

  const response = result?.data ?? result;

  if (response?.error) {
    throw new Error(response.error);
  }

  if (response?.ok === false) {
    throw new Error(response.message || "تعذر تنفيذ العملية.");
  }

  return response;
};

async function api(action, payload = {}) {
  const result = await call(action, payload);
  return getResponse(result);
}

function yearMatches(item, value) {
  return !value || Number(item.academic_year) === Number(value);
}

function branchMatches(item, value) {
  return !value || item.branch === value;
}

function cohortMatches(item, year, branch) {
  return yearMatches(item, year) && branchMatches(item, branch);
}

function isStudentInSession(student, session) {
  return (
    Number(student.academic_year) === Number(session.academic_year) &&
    student.branch === session.branch
  );
}

function getSession(sessionId) {
  return sessions.find(s => String(s.id) === String(sessionId));
}

function getStudent(studentId) {
  return students.find(s => String(s.id) === String(studentId));
}

function getSessionForRecord(record) {
  return getSession(record.session_id);
}

function recordStatus(record) {
  return record.status === "absent" ? "absent" : "present";
}

function statusText(status) {
  return status === "absent"
    ? '<span class="pill red status-absent">غائب</span>'
    : '<span class="pill green status-present">حاضر</span>';
}

function attendanceSourceText(source) {
  if (source === "manual") {
    return '<span class="pill" style="background:#164e36;color:#bbf7d0">يدوي</span>';
  }

  if (source === "system") {
    return '<span class="pill">غياب تلقائي</span>';
  }

  if (source === "legacy") {
    return '<span class="pill">سجل قديم</span>';
  }

  return '<span class="pill">QR</span>';
}

function table(headers, rows) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.map(row => `
            <tr>${row.map(cell => `<td>${cell ?? "—"}</td>`).join("")}</tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
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

  try {
    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id,name,role,active,archived_at")
      .eq("id", user.id)
      .maybeSingle();

    if (error) throw error;

    if (!profile) {
      throw new Error("لا يوجد سجل لهذا الحساب في جدول profiles.");
    }

    if (!["owner", "admin"].includes(profile.role)) {
      throw new Error("الدور الحالي غير مسموح له بدخول لوحة الإدارة.");
    }

    if (profile.active !== true || profile.archived_at) {
      throw new Error("حساب الإدارة غير نشط.");
    }

    $("adminEmail").textContent = user.email || "";
    $("loginMsg").innerHTML = "";

    show("loginView", false);
    show("appView");

    subscribeData();

  } catch (error) {
    console.error("Admin authentication error:", error);
    await signOut();

    $("loginMsg").innerHTML =
      `<div class="notice error">${esc(errText(error))}</div>`;

    show("loginView");
    show("appView", false);
  }
});

$("adminLogin").onclick = async () => {
  $("loginMsg").innerHTML = "";

  try {
    const { error } = await signInWithPassword({
      email: $("adminEmailInput").value.trim(),
      password: $("adminPassword").value
    });

    if (error) throw error;

  } catch (error) {
    $("loginMsg").innerHTML =
      `<div class="notice error">${esc(errText(error))}</div>`;
  }
};

$("adminPassword").addEventListener("keydown", event => {
  if (event.key === "Enter") $("adminLogin").click();
});

$("logoutBtn").onclick = () => signOut();

// =====================================
// الاشتراكات وتحميل البيانات
// =====================================

function cleanupSubscriptions() {
  subscriptions.forEach(channel => supabase.removeChannel(channel));
  subscriptions = [];
}

async function loadTable(tableName) {
  const { data, error } = await supabase
    .from(tableName)
    .select("*");

  if (error) {
    console.error(`Loading ${tableName}:`, error);
    throw error;
  }

  return data || [];
}

async function refreshData() {
  if (refreshing) {
    refreshAgain = true;
    return;
  }

  refreshing = true;

  try {
    const [profileRows, sessionRows, attendanceRows, auditRows] =
      await Promise.all([
        loadTable("profiles"),
        loadTable("sessions"),
        loadTable("attendance"),
        loadTable("audit_logs")
      ]);

    students = profileRows.filter(s => s.role === "student");
    sessions = sessionRows;
    attendance = attendanceRows;
    auditLogs = auditRows;

    renderAll();

  } catch (error) {
    console.error("Refresh error:", error);
  } finally {
    refreshing = false;

    if (refreshAgain) {
      refreshAgain = false;
      refreshData();
    }
  }
}

function subscribeData() {
  cleanupSubscriptions();
  refreshData();

  for (const tableName of [
    "profiles",
    "sessions",
    "attendance",
    "audit_logs"
  ]) {
    const channel = supabase
      .channel(`admin-${tableName}-${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: tableName
        },
        () => refreshData()
      )
      .subscribe();

    subscriptions.push(channel);
  }
}

function renderAll() {
  renderStudents();
  renderSessions();
  fillSessionFilter();
  fillManualAttendanceOptions();
  renderAttendance();
  renderDashboard();
  renderAudit();
  renderReportSummary();
  renderActiveQR();
}

// =====================================
// لوحة التحكم
// =====================================

function renderDashboard() {
  const year = $("dashboardYearFilter").value;
  const branch = $("dashboardBranchFilter").value;

  const studentList = students.filter(s =>
    !s.archived_at &&
    cohortMatches(s, year, branch)
  );

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todaySessionIds = new Set(
    sessions
      .filter(s =>
        cohortMatches(s, year, branch) &&
        s.created_at &&
        new Date(s.created_at).getTime() >= todayStart.getTime()
      )
      .map(s => String(s.id))
  );

  const todayRows = attendance.filter(r =>
    todaySessionIds.has(String(r.session_id))
  );

  const presentToday = todayRows.filter(r =>
    recordStatus(r) === "present"
  ).length;

  const absentToday = todayRows.filter(r =>
    recordStatus(r) === "absent"
  ).length;

  $("totalStudents").textContent = studentList.length;
  $("todayPresent").textContent = presentToday;
  $("todayAbsent").textContent = absentToday;

  $("totalSessions").textContent = sessions.filter(s =>
    cohortMatches(s, year, branch)
  ).length;

  const recent = [...attendance]
    .filter(r => {
      const session = getSessionForRecord(r);
      const item = session || r;
      return cohortMatches(item, year, branch);
    })
    .sort((a, b) =>
      new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
    )
    .slice(0, 8);

  $("recentAttendance").innerHTML = recent.length
    ? table(
        ["الطالب", "الكود", "المحاضرة", "الحالة", "طريقة التسجيل", "الوقت"],
        recent.map(r => [
          esc(r.student_name),
          esc(r.student_code),
          esc(r.session_title),
          statusText(recordStatus(r)),
          attendanceSourceText(r.source),
          dateText(r.timestamp)
        ])
      )
    : '<div class="empty">لا توجد سجلات مطابقة.</div>';
}

$("dashboardYearFilter").onchange = renderDashboard;
$("dashboardBranchFilter").onchange = renderDashboard;

// =====================================
// حساب حضور الطالب حسب المواد
// =====================================

function studentAttendanceStats(student, sessionList = sessions) {
  const enrolledAt = student.created_at
    ? new Date(student.created_at).getTime()
    : 0;

  const eligibleSessions = sessionList.filter(session => {
    if (!isStudentInSession(student, session)) return false;

    if (
      session.created_at &&
      new Date(session.created_at).getTime() < enrolledAt
    ) {
      return false;
    }

    const hasRecord = attendance.some(record =>
      String(record.student_id) === String(student.id) &&
      String(record.session_id) === String(session.id)
    );

    // لا نحسب الغياب قبل إنهاء المحاضرة.
    return session.active !== true || hasRecord;
  });

  const groups = new Map();

  eligibleSessions.forEach(session => {
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

    const studentRows = attendance.filter(record =>
      String(record.student_id) === String(student.id) &&
      ids.has(String(record.session_id))
    );

    const statusBySession = new Map();

    studentRows.forEach(record => {
      statusBySession.set(
        String(record.session_id),
        recordStatus(record)
      );
    });

    const total = group.sessions.length;
    const attended = group.sessions.filter(s =>
      statusBySession.get(String(s.id)) === "present"
    ).length;

    const absent = group.sessions.filter(s =>
      statusBySession.get(String(s.id)) === "absent"
    ).length;

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
    (sum, item) => sum + item.attended, 0
  );

  const absent = bySubject.reduce(
    (sum, item) => sum + item.absent, 0
  );

  return {
    attended,
    absent,
    total: attended + absent,
    bySubject
  };
}

// =====================================
// الطلاب
// =====================================

function renderStudents() {
  const query = ($("studentSearch").value || "").trim().toLowerCase();
  const year = $("studentYearFilter").value;
  const branch = $("studentBranchFilter").value;

  const list = students
    .filter(s => showArchivedStudents ? !!s.archived_at : !s.archived_at)
    .filter(s => cohortMatches(s, year, branch))
    .filter(s =>
      `${s.name || ""} ${s.code || ""} ${s.branch || ""}`
        .toLowerCase()
        .includes(query)
    )
    .sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "ar")
    );

  $("studentCount").textContent = `${list.length} طالب`;

  $("studentsTable").innerHTML = list.length
    ? table(
        [
          "الاسم",
          "الكود",
          "الفرقة",
          "الشعبة",
          "حضر",
          "غاب",
          "النسبة",
          "تفاصيل المواد",
          "الحالة",
          "تاريخ الإضافة",
          "الإجراءات"
        ],
        list.map(student => {
          const stats = studentAttendanceStats(student);

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
                    <span class="pill green">حضر ${item.attended}</span>
                    <span class="pill red">غاب ${item.absent}</span>
                    <span class="pill">${item.percentage}%</span>
                  </div>
                </div>
              `).join("")
            : "لا توجد محاضرات مكتملة";

          let actions = "";

          if (student.archived_at) {
            actions = `
              <button class="btn small success" data-restore="${esc(student.id)}">استعادة</button>
              <button class="btn small danger" data-delete="${esc(student.id)}">حذف نهائي</button>
            `;
          } else {
            actions = `
              <button class="btn small secondary" data-edit="${esc(student.id)}">تعديل</button>
              <button class="btn small ${student.active ? "danger" : "success"}"
                data-toggle="${esc(student.id)}"
                data-active="${!student.active}">
                ${student.active ? "إيقاف" : "تفعيل"}
              </button>
              <button class="btn small secondary" data-archive="${esc(student.id)}">أرشفة</button>
              <button class="btn small danger" data-delete="${esc(student.id)}">حذف نهائي</button>
            `;
          }

          return [
            esc(student.name),
            esc(student.code),
            esc(yearText(student.academic_year)),
            esc(student.branch || "غير محددة"),
            `<span class="pill green">${stats.attended}</span>`,
            `<span class="pill red">${stats.absent}</span>`,
            `<span class="pill">${percentage}%</span>`,
            `<div>${subjectDetails}</div>`,
            student.archived_at
              ? '<span class="pill red">مؤرشف</span>'
              : student.active
                ? '<span class="pill green">نشط</span>'
                : '<span class="pill red">موقوف</span>',
            dateText(student.created_at),
            actions
          ];
        })
      )
    : '<div class="empty">لا يوجد طلاب مطابقون.</div>';

  bindStudentActions();
}

function bindStudentActions() {
  $("studentsTable").querySelectorAll("[data-edit]").forEach(button => {
    button.onclick = () => editStudent(button.dataset.edit);
  });

  $("studentsTable").querySelectorAll("[data-toggle]").forEach(button => {
    button.onclick = async () => {
      if (!confirm("هل تريد تغيير حالة حساب الطالب؟")) return;

      button.disabled = true;

      try {
        await api("setStudentActive", {
          uid: button.dataset.toggle,
          active: button.dataset.active === "true"
        });
        await refreshData();
      } catch (error) {
        alert(errText(error));
        button.disabled = false;
      }
    };
  });

  $("studentsTable").querySelectorAll("[data-archive]").forEach(button => {
    button.onclick = async () => {
      if (!confirm("سيتم إخفاء الطالب وإيقاف حسابه مع الاحتفاظ بسجلات الحضور. هل تريد المتابعة؟")) return;

      button.disabled = true;

      try {
        await api("archiveStudent", { uid: button.dataset.archive });
        await refreshData();
        alert("تمت أرشفة الطالب.");
      } catch (error) {
        alert("تعذرت الأرشفة: " + errText(error));
        button.disabled = false;
      }
    };
  });

  $("studentsTable").querySelectorAll("[data-restore]").forEach(button => {
    button.onclick = async () => {
      if (!confirm("هل تريد استعادة الطالب وتفعيل حسابه؟")) return;

      button.disabled = true;

      try {
        await api("restoreStudent", { uid: button.dataset.restore });
        await refreshData();
        alert("تمت استعادة الطالب.");
      } catch (error) {
        alert("تعذرت الاستعادة: " + errText(error));
        button.disabled = false;
      }
    };
  });

  $("studentsTable").querySelectorAll("[data-delete]").forEach(button => {
    button.onclick = async () => {
      if (!confirm("تحذير: سيتم حذف حساب الطالب وجميع سجلات حضوره نهائيًا.")) return;
      if (!confirm("تأكيد أخير: هل تريد الحذف النهائي؟")) return;

      button.disabled = true;

      try {
        await api("deleteStudent", { uid: button.dataset.delete });
        await refreshData();
        alert("تم حذف الطالب.");
      } catch (error) {
        alert("تعذر الحذف: " + errText(error));
        button.disabled = false;
      }
    };
  });
}

$("studentSearch").oninput = renderStudents;
$("studentYearFilter").onchange = renderStudents;
$("studentBranchFilter").onchange = renderStudents;

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
// إضافة وتعديل الطلاب
// =====================================

$("addStudentBtn").onclick = () => {
  $("studentForm").reset();

  $("editUid").value = "";
  $("studentCode").disabled = false;
  $("studentAcademicYear").value = "";
  $("studentBranch").value = "";

  $("nationalIdField").style.display = "";
  $("studentNationalId").required = true;

  $("studentModalTitle").textContent = "إضافة طالب";
  $("studentFormMsg").innerHTML = "";

  modal("studentModal");
};

function editStudent(uid) {
  const student = getStudent(uid);
  if (!student) return;

  $("studentForm").reset();

  $("editUid").value = uid;
  $("studentName").value = student.name || "";
  $("studentCode").value = student.code || "";
  $("studentAcademicYear").value = student.academic_year || "";
  $("studentBranch").value = student.branch || "";

  $("studentCode").disabled = true;

  $("nationalIdField").style.display = "none";
  $("studentNationalId").required = false;

  $("studentModalTitle").textContent = "تعديل بيانات الطالب";
  $("studentFormMsg").innerHTML = "";

  modal("studentModal");
}

$("studentForm").onsubmit = async event => {
  event.preventDefault();
  $("studentFormMsg").innerHTML = "";

  const button = $("studentForm").querySelector('[type="submit"]');
  button.disabled = true;

  try {
    const uid = $("editUid").value;
    const name = $("studentName").value.trim();
    const branch = $("studentBranch").value;
    const academicYear = Number($("studentAcademicYear").value);

    if (!YEARS.includes(academicYear)) {
      throw new Error("اختر الفرقة الدراسية.");
    }

    if (!BRANCHES.includes(branch)) {
      throw new Error("اختر الشعبة.");
    }

    if (uid) {
      await api("updateStudent", {
        uid,
        name,
        branch,
        academicYear
      });
    } else {
      await api("createStudent", {
        name,
        code: $("studentCode").value.trim(),
        nationalId: $("studentNationalId").value.trim(),
        branch,
        academicYear
      });
    }

    modal("studentModal", false);
    $("studentForm").reset();
    await refreshData();

  } catch (error) {
    $("studentFormMsg").innerHTML =
      `<div class="notice error">${esc(errText(error))}</div>`;
  } finally {
    button.disabled = false;
  }
};

// =====================================
// إنشاء عدة محاضرات مستقلة
// =====================================

$("newSessionBtn").onclick = () => {
  $("sessionForm").reset();
  $("sessionMsg").innerHTML = "";
  $("sessionAcademicYear").value = "";
  $("sessionBranch").value = "";
  $("sessionDuration").value = 30;
  modal("sessionModal");
};

$("sessionForm").onsubmit = async event => {
  event.preventDefault();
  $("sessionMsg").innerHTML = "";

  const button = $("sessionForm").querySelector('[type="submit"]');
  button.disabled = true;

  try {
    const academicYear = Number($("sessionAcademicYear").value);
    const branch = $("sessionBranch").value;

    if (!YEARS.includes(academicYear)) {
      throw new Error("اختر الفرقة الدراسية.");
    }

    if (!BRANCHES.includes(branch)) {
      throw new Error("اختر الشعبة.");
    }

    const response = await api("createSession", {
      subject: $("sessionSubject").value.trim(),
      title: $("sessionTitle").value.trim(),
      durationMinutes: Number($("sessionDuration").value),
      academicYear,
      branch
    });

    if (!response?.id || !response?.token) {
      throw new Error("تم إنشاء الطلب، لكن لم يصل رمز QR من السيرفر. راجع سجل المحاضرات قبل إعادة المحاولة.");
    }

    // الرمز الخام يبقى في ذاكرة الصفحة فقط.
    qrTokens.set(String(response.id), response.token);

    modal("sessionModal", false);
    $("sessionForm").reset();

    await refreshData();
    renderActiveQR();

  } catch (error) {
    $("sessionMsg").innerHTML =
      `<div class="notice error">${esc(errText(error))}</div>`;
  } finally {
    button.disabled = false;
  }
};

// =====================================
// بطاقات QR لكل المحاضرات النشطة
// =====================================

function sessionIsActive(session) {
  return (
    session.active === true &&
    session.expires_at &&
    new Date(session.expires_at).getTime() > Date.now()
  );
}

function filteredSessionsForQr() {
  const year = $("sessionYearFilter").value;
  const branch = $("sessionBranchFilter").value;

  return sessions
    .filter(session => sessionIsActive(session))
    .filter(session => cohortMatches(session, year, branch))
    .sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );
}

function renderActiveQR() {
  const active = filteredSessionsForQr();

  if (!active.length) {
    $("activeQr").innerHTML =
      '<div class="empty">لا توجد محاضرات نشطة في المجموعة المختارة.</div>';
    return;
  }

  $("activeQr").innerHTML = `
    <div class="qr-grid">
      ${active.map(session => {
        const token = qrTokens.get(String(session.id));

        return `
          <div class="qr-card" data-qr-card="${esc(session.id)}">
            <span class="pill green">محاضرة نشطة</span>

            <h3>${esc(session.subject || "غير محددة")}</h3>
            <div>${esc(session.title)}</div>

            <div style="margin-top:8px">
              <span class="cohort-label">${esc(yearText(session.academic_year))}</span>
              <span class="cohort-label">${esc(session.branch || "شعبة غير محددة")}</span>
            </div>

            ${
              token
                ? `<div class="qr-image"><div id="qr-${esc(session.id)}"></div></div>
                   <div class="muted-small">صالح حتى: ${dateText(session.expires_at)}</div>`
                : `<div class="qr-warning">
                    رمز QR غير متاح بعد إعادة تحميل الصفحة.
                    يمكنك إنهاء المحاضرة وإنشاء محاضرة جديدة للحصول على رمز جديد.
                  </div>`
            }

            <button class="btn danger" data-end-session="${esc(session.id)}"
              style="margin-top:12px">
              إنهاء المحاضرة
            </button>
          </div>
        `;
      }).join("")}
    </div>
  `;

  active.forEach(session => {
    const token = qrTokens.get(String(session.id));
    if (!token) return;

    const target = $(`qr-${session.id}`);
    if (!target) return;

    const payload = JSON.stringify({
      sessionId: session.id,
      token
    });

    new QRCode(target, {
      text: payload,
      width: 210,
      height: 210,
      colorDark: "#06152c",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.H
    });
  });

  $("activeQr").querySelectorAll("[data-end-session]").forEach(button => {
    button.onclick = async () => {
      const sessionId = button.dataset.endSession;
      const session = getSession(sessionId);

      if (!session) {
        alert("المحاضرة غير موجودة.");
        return;
      }

      if (!confirm(
        `هل تريد إنهاء محاضرة ${session.title}؟ سيتم تسجيل الغياب تلقائيًا لطلاب المجموعة النشطين الذين لم يسجلوا حضورهم.`
      )) return;

      button.disabled = true;

      try {
        await api("endSession", { sessionId });

        qrTokens.delete(String(sessionId));
        await refreshData();

        alert("تم إنهاء المحاضرة ومراجعة سجلات الغياب.");
      } catch (error) {
        alert("تعذر إنهاء المحاضرة: " + errText(error));
        button.disabled = false;
      }
    };
  });
}

$("sessionYearFilter").onchange = () => {
  renderActiveQR();
  renderSessions();
};

$("sessionBranchFilter").onchange = () => {
  renderActiveQR();
  renderSessions();
};

// =====================================
// قائمة المحاضرات وتجميعها
// =====================================

function renderSessions() {
  const year = $("sessionYearFilter").value;
  const branch = $("sessionBranchFilter").value;

  const list = sessions
    .filter(s => cohortMatches(s, year, branch))
    .sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

  const groups = new Map();

  list.forEach(session => {
    // لا نخلط مادة فرقة أو شعبة مع مجموعة أخرى.
    const key = [
      normalizeSubject(session.subject),
      session.academic_year ?? "legacy",
      session.branch || "legacy"
    ].join("|");

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  });

  $("sessionsTable").innerHTML = groups.size
    ? table(
        [
          "المادة",
          "الفرقة والشعبة",
          "عدد المحاضرات",
          "آخر محاضرة",
          "آخر إنشاء",
          "الحالة",
          "الإجراءات"
        ],
        [...groups.values()].map(group => {
          const latest = group[0];
          const active = group.some(session => sessionIsActive(session));

          return [
            esc(latest.subject || "غير محددة"),
            esc(cohortText(latest.academic_year, latest.branch)),
            `<span class="pill">${group.length} محاضرة</span>`,
            esc(latest.title),
            dateText(latest.created_at),
            active
              ? '<span class="pill green">نشطة</span>'
              : '<span class="pill red">منتهية</span>',
            group.map(session => `
              <div style="margin:4px 0">
                <span class="muted-small">${esc(session.title)} — ${dateText(session.created_at)}</span>
                <button class="btn small danger"
                  data-delete-session="${esc(session.id)}">
                  حذف
                </button>
              </div>
            `).join("")
          ];
        })
      )
    : '<div class="empty">لا توجد محاضرات مطابقة.</div>';

  $("sessionsTable").querySelectorAll("[data-delete-session]").forEach(button => {
    button.onclick = async () => {
      const sessionId = button.dataset.deleteSession;
      const session = getSession(sessionId);

      if (!session) {
        alert("المحاضرة غير موجودة.");
        return;
      }

      if (!confirm(
        `هل تريد حذف المحاضرة "${session.title}"؟ سيتم حذف سجلات حضورها أيضًا.`
      )) return;

      if (!confirm("تأكيد أخير: حذف المحاضرة وسجلاتها نهائيًا؟")) return;

      button.disabled = true;

      try {
        await api("deleteSession", { sessionId });

        qrTokens.delete(String(sessionId));
        await refreshData();

        alert("تم حذف المحاضرة.");
      } catch (error) {
        alert(
          "تعذر حذف المحاضرة. قد تكون دالة الحذف المطلوبة غير موجودة في قاعدة البيانات.\n" +
          errText(error)
        );
        button.disabled = false;
      }
    };
  });
}

// =====================================
// فلاتر سجلات الحضور
// =====================================

function getAttendanceFilteredSessions() {
  const year = $("attendanceYearFilter").value;
  const branch = $("attendanceBranchFilter").value;

  return sessions.filter(s => cohortMatches(s, year, branch));
}

function fillSessionFilter() {
  const subjectSelect = $("attendanceSubject");
  const sessionSelect = $("attendanceSession");

  const oldSubject = subjectSelect.value;
  const oldSession = sessionSelect.value;

  const filteredSessions = getAttendanceFilteredSessions();
  const subjectMap = new Map();

  filteredSessions.forEach(session => {
    const key = normalizeSubject(session.subject);
    if (!subjectMap.has(key)) {
      subjectMap.set(key, session.subject || "غير محددة");
    }
  });

  subjectSelect.innerHTML =
    '<option value="">كل المواد</option>' +
    [...subjectMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "ar"))
      .map(([key, subject]) =>
        `<option value="${esc(key)}">${esc(subject)}</option>`
      ).join("");

  subjectSelect.value = subjectMap.has(oldSubject) ? oldSubject : "";

  const subjectSessions = filteredSessions.filter(session =>
    !subjectSelect.value ||
    normalizeSubject(session.subject) === subjectSelect.value
  );

  sessionSelect.innerHTML =
    '<option value="">كل المحاضرات</option>' +
    subjectSessions
      .sort((a, b) =>
        new Date(b.created_at || 0) - new Date(a.created_at || 0)
      )
      .map(session => `
        <option value="${esc(session.id)}">
          ${esc(session.title)} — ${esc(dateText(session.created_at))}
        </option>
      `).join("");

  sessionSelect.value = subjectSessions.some(s =>
    String(s.id) === String(oldSession)
  ) ? oldSession : "";
}

function attendanceRowsForCurrentFilters() {
  const year = $("attendanceYearFilter").value;
  const branch = $("attendanceBranchFilter").value;
  const subject = $("attendanceSubject").value;
  const selectedSession = $("attendanceSession").value;
  const query = $("attendanceSearch").value.trim().toLowerCase();

  return attendance.filter(record => {
    const session = getSessionForRecord(record);
    const cohort = session || record;

    if (!cohortMatches(cohort, year, branch)) return false;

    if (
      selectedSession &&
      String(record.session_id) !== String(selectedSession)
    ) return false;

    if (
      subject &&
      normalizeSubject(session?.subject) !== subject
    ) return false;

    const searchable = [
      record.student_name,
      record.student_code,
      record.session_title,
      session?.subject
    ].join(" ").toLowerCase();

    return searchable.includes(query);
  }).sort((a, b) =>
    new Date(b.timestamp || 0) - new Date(a.timestamp || 0)
  );
}

function renderAttendance() {
  const rows = attendanceRowsForCurrentFilters();

  $("attendanceTable").innerHTML = rows.length
    ? table(
        [
          "الطالب",
          "الكود",
          "الفرقة",
          "الشعبة",
          "المادة",
          "المحاضرة",
          "الحالة",
          "طريقة التسجيل",
          "وقت التسجيل"
        ],
        rows.map(record => {
          const session = getSessionForRecord(record);
          const cohort = session || record;

          return [
            esc(record.student_name),
            esc(record.student_code),
            esc(yearText(cohort.academic_year)),
            esc(cohort.branch || "غير محددة"),
            esc(session?.subject || "غير محددة"),
            esc(record.session_title),
            statusText(recordStatus(record)),
            attendanceSourceText(record.source),
            dateText(record.timestamp)
          ];
        })
      )
    : '<div class="empty">لا توجد سجلات مطابقة.</div>';
}

$("attendanceYearFilter").onchange = () => {
  fillSessionFilter();
  renderAttendance();
};

$("attendanceBranchFilter").onchange = () => {
  fillSessionFilter();
  renderAttendance();
};

$("attendanceSubject").onchange = () => {
  fillSessionFilter();
  renderAttendance();
};

$("attendanceSession").onchange = renderAttendance;
$("attendanceSearch").oninput = renderAttendance;

// =====================================
// الحضور اليدوي حسب مجموعة المحاضرة
// =====================================

const manualSubjectSelect = $("manualAttendanceSubject");
const manualSessionSelect = $("manualAttendanceSession");
const manualSearchInput = $("manualStudentSearch");
const manualStudentUidInput = $("manualStudentUid");
const manualResults = $("manualStudentResults");
const manualSelectedBox = $("manualSelectedStudent");
const manualSubmitBtn = $("saveManualAttendanceBtn");
const manualMessage = $("manualAttendanceMsg");

function fillManualAttendanceOptions() {
  const oldSubject = manualSubjectSelect.value;
  const oldSession = manualSessionSelect.value;

  const subjectMap = new Map();

  sessions.forEach(session => {
    const key = normalizeSubject(session.subject);
    if (!subjectMap.has(key)) {
      subjectMap.set(key, session.subject || "غير محددة");
    }
  });

  manualSubjectSelect.innerHTML =
    '<option value="">اختر المادة</option>' +
    [...subjectMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "ar"))
      .map(([key, subject]) =>
        `<option value="${esc(key)}">${esc(subject)}</option>`
      ).join("");

  manualSubjectSelect.value = subjectMap.has(oldSubject)
    ? oldSubject
    : "";

  fillManualSessionOptions(oldSession);
}

function fillManualSessionOptions(oldSession = "") {
  const subject = manualSubjectSelect.value;

  const filtered = sessions
    .filter(session =>
      subject &&
      normalizeSubject(session.subject) === subject
    )
    .sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    );

  manualSessionSelect.innerHTML =
    '<option value="">اختر المحاضرة</option>' +
    filtered.map(session => `
      <option value="${esc(session.id)}">
        ${esc(session.title)} — ${esc(yearText(session.academic_year))} — ${esc(session.branch || "شعبة غير محددة")} — ${esc(dateText(session.created_at))}
      </option>
    `).join("");

  manualSessionSelect.disabled = filtered.length === 0;

  manualSessionSelect.value = filtered.some(s =>
    String(s.id) === String(oldSession)
  ) ? oldSession : "";
}

function clearManualStudent() {
  manualStudentUidInput.value = "";
  manualSelectedBox.hidden = true;
  manualSelectedBox.innerHTML = "";
  manualSubmitBtn.disabled = true;
}

function getManualSession() {
  return getSession(manualSessionSelect.value);
}

function renderManualStudentResults() {
  clearManualStudent();

  const query = manualSearchInput.value.trim().toLowerCase();
  const session = getManualSession();

  if (!query || !session) {
    manualResults.hidden = true;
    manualResults.innerHTML = "";
    return;
  }

  const alreadyRecorded = new Set(
    attendance
      .filter(r => String(r.session_id) === String(session.id))
      .map(r => String(r.student_id))
  );

  const matches = students
    .filter(student =>
      student.role === "student" &&
      student.active === true &&
      !student.archived_at &&
      isStudentInSession(student, session)
    )
    .filter(student =>
      !alreadyRecorded.has(String(student.id))
    )
    .filter(student =>
      `${student.name || ""} ${student.code || ""}`
        .toLowerCase()
        .includes(query)
    )
    .sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), "ar")
    )
    .slice(0, 30);

  if (!matches.length) {
    manualResults.hidden = false;
    manualResults.innerHTML =
      '<div class="empty">لا يوجد طالب مطابق غير مسجل في هذه المحاضرة.</div>';
    return;
  }

  manualResults.hidden = false;

  manualResults.innerHTML = matches.map(student => `
    <button type="button" class="manual-student-item"
      data-manual-student="${esc(student.id)}">
      <span>
        <strong>${esc(student.name)}</strong>
        <small style="display:block;color:#94a3b8;margin-top:4px">
          كود الطالب: ${esc(student.code)}
        </small>
      </span>
      <span class="pill green">نشط</span>
    </button>
  `).join("");

  manualResults.querySelectorAll("[data-manual-student]").forEach(button => {
    button.onclick = () => {
      const student = getStudent(button.dataset.manualStudent);
      const selectedSession = getManualSession();

      if (
        !student ||
        !selectedSession ||
        student.active !== true ||
        student.archived_at ||
        !isStudentInSession(student, selectedSession)
      ) {
        alert("الطالب لا ينتمي إلى مجموعة المحاضرة أو حسابه غير نشط.");
        return;
      }

      selectManualStudent(student);
    };
  });
}

function selectManualStudent(student) {
  manualStudentUidInput.value = student.id;

  manualSelectedBox.hidden = false;
  manualSelectedBox.innerHTML = `
    <strong>الطالب المختار</strong>
    <div style="margin-top:6px">${esc(student.name)}</div>
    <div class="muted" style="font-size:12px">كود الطالب: ${esc(student.code)}</div>
    <div class="muted" style="font-size:12px">
      ${esc(cohortText(student.academic_year, student.branch))}
    </div>
  `;

  manualResults.hidden = true;
  manualResults.innerHTML = "";
  manualSubmitBtn.disabled = false;
}

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

manualSubjectSelect.onchange = () => {
  fillManualSessionOptions();
  manualSearchInput.value = "";
  manualResults.hidden = true;
  manualResults.innerHTML = "";
  clearManualStudent();
  manualMessage.innerHTML = "";
};

manualSessionSelect.onchange = () => {
  manualSearchInput.value = "";
  manualResults.hidden = true;
  manualResults.innerHTML = "";
  clearManualStudent();
  manualMessage.innerHTML = "";
};

manualSearchInput.oninput = () => {
  manualMessage.innerHTML = "";
  renderManualStudentResults();
};

$("manualAttendanceForm").onsubmit = async event => {
  event.preventDefault();
  manualMessage.innerHTML = "";

  const session = getManualSession();
  const student = getStudent(manualStudentUidInput.value);

  if (!session || !student) {
    manualMessage.innerHTML =
      '<div class="notice error">اختر المحاضرة والطالب أولاً.</div>';
    return;
  }

  if (
    student.active !== true ||
    student.archived_at ||
    !isStudentInSession(student, session)
  ) {
    manualMessage.innerHTML =
      '<div class="notice error">الطالب غير نشط أو لا ينتمي إلى مجموعة المحاضرة.</div>';
    return;
  }

  const existing = attendance.find(record =>
    String(record.session_id) === String(session.id) &&
    String(record.student_id) === String(student.id)
  );

  if (existing) {
    manualMessage.innerHTML =
      `<div class="notice error">يوجد سجل سابق لهذا الطالب في المحاضرة: ${recordStatus(existing) === "absent" ? "غائب" : "حاضر"}.</div>`;
    return;
  }

  manualSubmitBtn.disabled = true;
  manualSubmitBtn.textContent = "جارٍ تسجيل الحضور...";

  try {
    const response = await api("manualAttendance", {
      sessionId: session.id,
      studentUid: student.id
    });

    manualMessage.innerHTML =
      `<div class="notice success">${esc(response.message || "تم تسجيل الحضور.")}</div>`;

    await refreshData();

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
// التقارير وتصدير Excel
// =====================================

function reportRows() {
  const year = $("reportYearFilter").value;
  const branch = $("reportBranchFilter").value;

  return attendance.filter(record => {
    const session = getSessionForRecord(record);
    return cohortMatches(session || record, year, branch);
  });
}

function renderReportSummary() {
  const rows = reportRows();

  const present = rows.filter(r => recordStatus(r) === "present").length;
  const absent = rows.filter(r => recordStatus(r) === "absent").length;

  $("reportSummary").innerHTML = `
    <div class="grid">
      <div class="stat">
        <div class="stat-label">إجمالي السجلات</div>
        <div class="stat-value">${rows.length}</div>
      </div>
      <div class="stat">
        <div class="stat-label">الحضور</div>
        <div class="stat-value status-present">${present}</div>
      </div>
      <div class="stat">
        <div class="stat-label">الغياب</div>
        <div class="stat-value status-absent">${absent}</div>
      </div>
    </div>
  `;
}

$("reportYearFilter").onchange = renderReportSummary;
$("reportBranchFilter").onchange = renderReportSummary;

$("exportExcel").onclick = () => {
  const rows = reportRows().map(record => {
    const session = getSessionForRecord(record);
    const cohort = session || record;

    return {
      "اسم الطالب": record.student_name,
      "كود الطالب": record.student_code,
      "الفرقة": yearText(cohort.academic_year),
      "الشعبة": cohort.branch || "غير محددة",
      "المادة": session?.subject || "غير محددة",
      "المحاضرة": record.session_title,
      "الحالة": recordStatus(record) === "absent" ? "غائب" : "حاضر",
      "طريقة التسجيل": record.source === "manual"
        ? "يدوي"
        : record.source === "system"
          ? "غياب تلقائي"
          : record.source === "legacy"
            ? "سجل قديم"
            : "QR",
      "التاريخ": dateText(record.timestamp)
    };
  });

  if (!rows.length) {
    alert("لا توجد بيانات للتصدير حسب الفلاتر المحددة.");
    return;
  }

  if (typeof XLSX === "undefined") {
    alert("مكتبة Excel لم يتم تحميلها.");
    return;
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");

  const year = $("reportYearFilter").value || "all";
  const branch = $("reportBranchFilter").value
    ? $("reportBranchFilter").value.replace(/\s/g, "-")
    : "all";

  XLSX.writeFile(
    workbook,
    `MOZA-Attendance-${year}-${branch}-${new Date().toISOString().slice(0, 10)}.xlsx`
  );
};

// =====================================
// سجل العمليات
// =====================================

function renderAudit() {
  const rows = [...auditLogs]
    .sort((a, b) =>
      new Date(b.created_at || 0) - new Date(a.created_at || 0)
    )
    .slice(0, 200);

  $("auditTable").innerHTML = rows.length
    ? table(
        ["العملية", "المدير", "التفاصيل", "التوقيت"],
        rows.map(item => [
          esc(item.action),
          esc(item.admin_uid),
          esc(JSON.stringify(item.details || {})),
          dateText(item.created_at)
        ])
      )
    : '<div class="empty">لا توجد عمليات مسجلة.</div>';
}

// =====================================
// التنقل وإغلاق النوافذ
// =====================================

document.querySelectorAll("[data-tab]").forEach(button => {
  button.onclick = () => {
    document.querySelectorAll("[data-tab]").forEach(item =>
      item.classList.toggle("active", item === button)
    );

    document.querySelectorAll("main section").forEach(section => {
      section.hidden = section.id !== `tab-${button.dataset.tab}`;
    });

    if (button.dataset.tab === "sessions") {
      renderActiveQR();
    }

    if (button.dataset.tab === "attendance") {
      fillSessionFilter();
      renderAttendance();
    }
  };
});

document.querySelectorAll("[data-close]").forEach(button => {
  button.onclick = () => modal(button.dataset.close, false);
});

document.querySelectorAll(".modal").forEach(element => {
  element.addEventListener("click", event => {
    if (event.target === element) {
      modal(element.id, false);
    }
  });
});
