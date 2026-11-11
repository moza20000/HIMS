import { supabase, auth, signInWithPassword, signOut, onAuthStateChanged, call, studentEmail } from "./supabase.js";
const $=id=>document.getElementById(id);
let scanner=null, scanning=false;
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=(id,text,type="notice")=>$(id).innerHTML=`<div class="notice ${type}">${esc(text)}</div>`;
async function showUser(user){
  if(!user){$("loginView").style.display="grid";$("studentView").style.display="none";return;}
  const {data:profile,error}=await supabase.from("profiles").select("id,name,code,active,role").eq("id",user.id).maybeSingle();
  if(error||!profile||profile.active!==true||profile.role!=="student"){await signOut();msg("loginMsg","الحساب غير نشط أو غير مسجل كطالب.","error");return;}
  $("welcomeName").textContent=`أهلاً ${profile.name}`;
  $("loginView").style.display="none";$("studentView").style.display="block";
}
onAuthStateChanged(showUser);
$("studentLogin").onclick=async()=>{
  $("loginMsg").innerHTML="";
  const code=$("studentCode").value.trim(),nationalId=$("studentNationalId").value.trim();
  if(!/^[a-zA-Z0-9_-]{3,32}$/.test(code)||!/^[0-9]{14}$/.test(nationalId)){msg("loginMsg","تأكد من كود الطالب والرقم القومي المكون من 14 رقمًا.","error");return;}
  try{const {error}=await signInWithPassword({email:studentEmail(code),password:nationalId});if(error)throw error;}
  catch(e){msg("loginMsg","بيانات الدخول غير صحيحة أو الحساب غير نشط.","error");}
};
$("logout").onclick=async()=>{if(scanner&&scanning){await scanner.stop().catch(()=>{});scanning=false;}await signOut();};
$("scanBtn").onclick=async()=>{
  const {data:{user}}=await auth.getUser();
  if(!user){msg("resultMsg","سجّل الدخول أولاً.","error");return;}
  if(typeof Html5Qrcode==="undefined"){msg("resultMsg","تعذر تحميل قارئ QR. تحقق من اتصال الإنترنت.","error");return;}
  if(scanning){await scanner.stop().catch(()=>{});scanning=false;$("scanBtn").textContent="فتح الكاميرا ومسح QR";return;}
  scanner=new Html5Qrcode("reader");
  try{
    await scanner.start({facingMode:"environment"},{fps:10,qrbox:{width:240,height:240}},async decoded=>{
      if(!scanning)return;scanning=false;await scanner.stop().catch(()=>{});$("scanBtn").textContent="فتح الكاميرا ومسح QR";
      try{
        const payload=JSON.parse(decoded);
        if(!payload.sessionId||!payload.token)throw new Error("رمز QR غير مفهوم.");
        const result=await call("markAttendance",{sessionId:payload.sessionId,token:payload.token});
        msg("resultMsg",`تم تسجيل حضور ${result.data.studentName} في ${result.data.sessionTitle} بنجاح.`,"success-note");
      }catch(e){msg("resultMsg",e.message.includes("سبق")?"تم تسجيل حضورك بالفعل.":e.message||"تعذر تسجيل الحضور.","error");}
    });
    scanning=true;$("scanBtn").textContent="إيقاف الكاميرا";
  }catch(e){msg("resultMsg","تعذر تشغيل الكاميرا. اسمح للموقع باستخدام الكاميرا وتأكد من استخدام HTTPS.","error");}
};
