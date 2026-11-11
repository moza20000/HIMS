# MOZA Attendance — Supabase edition

نسخة المشروع الأصلية بعد تحويل طبقة البيانات والمصادقة من Firebase إلى Supabase، مع الإبقاء على ملفات الواجهات والتصميم الحاليين (`index.html`, `admin.html`, `shared.css`) ووظائف الطلاب والإدارة وQR والحضور والتقارير وExcel.

## الملفات المهمة

- `index.html` و`student.js`: بوابة الطالب، الدخول بالكود والرقم القومي، ومسح QR.
- `admin.html` و`admin.js`: لوحة الإدارة وإدارة الطلاب والمحاضرات وسجلات الحضور والتقارير.
- `shared.css`: التصميم الأصلي دون إعادة بناء الواجهة.
- `supabase-config.js`: عنوان المشروع وPublishable Key فقط.
- `supabase/migrations/001_moza_schema.sql`: الجداول والفهارس وRLS وRealtime trigger.
- `supabase/functions/moza-api/index.ts`: عمليات الإدارة والحضور الآمنة من جهة الخادم.

## 1) إعداد قاعدة Supabase

1. افتح مشروعك: `https://nyocltkitrthjpgsemwr.supabase.co`.
2. من SQL Editor نفّذ محتوى `supabase/migrations/001_moza_schema.sql` بالكامل.
3. من Authentication > Providers تأكد من تفعيل Email provider.
4. من Project Settings > API انسخ Project URL وPublishable Key. القيم الحالية موجودة في `supabase-config.js` ويمكن تعديلها إذا تغيرت.

## 2) نشر Edge Function

يتطلب ذلك Supabase CLI على جهازك، وليس Firebase Blaze:

```bash
npm install -g supabase
supabase login
supabase link --project-ref nyocltkitrthjpgsemwr
supabase functions deploy moza-api
```

تحتاج الدالة إلى أسرار الخادم التي يوفّرها Supabase تلقائيًا داخل بيئة Edge Functions:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

لا تنسخ `SUPABASE_SERVICE_ROLE_KEY` إلى ملفات المشروع أو GitHub أو المتصفح. الدالة تستخدمه من بيئة Supabase الخادمية فقط. لا يلزم وضع Database Password في ملفات الموقع.

## 3) إنشاء حساب Owner الأول

1. من Supabase Dashboard > Authentication > Users أنشئ مستخدمًا ببريد الإدارة وكلمة مرور قوية.
2. بعد إنشائه افتح SQL Editor ونفّذ `supabase/README-OWNER.sql` بعد استبدال `YOUR_ADMIN_EMAIL_HERE` بالبريد الحقيقي.
3. سجّل الدخول من `admin.html`. سيظهر الحساب كـ Owner.
4. أضف حسابات Admin لاحقًا من خلال تعديل `profiles.role` إلى `admin` في SQL Editor، بعد التحقق من هوية الحساب. لا تمنح الدور من واجهة عامة.

كل مستخدم جديد ينشأ عبر Auth يبدأ بدور `student` تلقائيًا. لا يتم الوثوق في بيانات role التي يرسلها المتصفح.

## 4) نشر GitHub Pages

ارفع ملفات المشروع إلى نفس مستودع GitHub، مع الحفاظ على مسار الملفات كما هو، ثم فعّل GitHub Pages من Settings > Pages. الصفحة الرئيسية هي `index.html` ولوحة الإدارة `admin.html`.

روابط النشر ستكون:
- الطالب: `https://moza20000.github.io/mooooooooza/`
- الإدارة: `https://moza20000.github.io/mooooooooza/admin.html`

تحتاج الكاميرا إلى HTTPS، وGitHub Pages يوفر HTTPS.

## الأمان

- المتصفح يحتوي على Publishable Key فقط؛ هذا المفتاح ليس سرًا.
- لا توجد كتابة مباشرة من المتصفح إلى الجداول. كل عمليات الإنشاء والتعديل والحضور تمر عبر Edge Function تتحقق من جلسة المستخدم ودوره وحالة حسابه.
- RLS مفعّل على كل الجداول. الطلاب يستطيعون قراءة ملفهم الشخصي فقط؛ الإدارة تقرأ البيانات اللازمة للوحة التحكم. سجلات الحضور والجلسات وسجل العمليات غير متاحة للطلاب.
- Edge Function تستخدم Service Role Key من أسرار بيئة Supabase، ولا تكشفه للعميل.
- رمز QR عشوائي مؤقت، ويُخزّن hash فقط. التحقق من الصلاحية والوقت ومنع التكرار يتم على الخادم وقيد unique على (session_id, student_id).
- الرقم القومي يُستخدم كلمة مرور لحساب الطالب في Supabase Auth ولا يُحفظ في جدول profiles أو سجل العمليات. حافظ على خصوصيته ولا تطبعه في تقارير.
- استخدم كلمات مرور قوية لحسابات الإدارة، وفعّل MFA للإدارة من إعدادات Supabase عند الإمكان.

## ملاحظات الترحيل والاختبار

- ملفات ZIP الأصلية لا تحتوي على نسخة بيانات Firebase الفعلية، لذلك هذا التحديث ينقل التطبيق والبنية البرمجية فقط ولا يستطيع نقل الطلاب أو سجلات الحضور الموجودة في Firebase تلقائيًا. إذا كانت هناك بيانات قديمة مطلوبة، صدّر JSON من Firebase Realtime Database واحتفظ به كنسخة احتياطية قبل إيقاف Firebase؛ يجب إعداد استيراد منفصل مع مطابقة معرفات المستخدمين.
- بعد تنفيذ SQL ونشر Edge Function وإنشاء Owner، اختبر ببيانات تجريبية: إنشاء طالب، تسجيل دخوله، إنشاء جلسة QR، تسجيل حضور مرة واحدة، محاولة التكرار، إيقاف الطالب، ثم تصدير Excel.
- إحصائية الغياب اليومية في التصميم الحالي تقديرية: عدد الطلاب النشطين ناقص سجلات الحضور اليوم. إذا كانت هناك عدة محاضرات أو مجموعات في اليوم، لا تعتبرها كشف غياب رسميًا دون تحديد سياسة الغياب المطلوبة.
- لم يتم الاتصال بمشروع Supabase أو نشر الدالة أو إجراء اختبار حي من داخل هذه البيئة؛ يجب تنفيذ خطوات الإعداد أعلاه على حساب مالك المشروع.


## تشخيص تسجيل دخول الإدارة
هذه النسخة تعرض السبب الفعلي لفشل فحص صلاحيات الإدارة (خطأ قاعدة البيانات، غياب سجل profiles، الدور، أو حالة الحساب) بدل رسالة عامة. لا تتجاوز فحص الصلاحيات ولا تمنح صلاحيات تلقائيًا.
