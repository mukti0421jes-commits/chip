package main

// HTML for the RJ Slot Hub user portal (login + dashboard).
// Brand: RJ Slot Hub. Dark navy + blue/cyan theme.

const portalLoginHTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RJ Slot Hub — Sign in</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Quicksand:wght@500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',system-ui,sans-serif}
body{min-height:100vh;background:radial-gradient(1200px 600px at 15% 0%,rgba(34,211,238,.18),transparent 55%),linear-gradient(160deg,#080b16,#0b1020 60%,#060912);color:#ece4cf;display:flex;align-items:center;overflow:hidden}
.wrap{display:flex;width:100%;min-height:100vh;align-items:center}
.brand{flex:1;padding:0 8% ;display:flex;flex-direction:column;justify-content:center}
.brand .logo{font-size:74px;font-weight:600;font-family:Quicksand,sans-serif;letter-spacing:-1px;line-height:1}
.brand .logo span{background:linear-gradient(135deg,#a5f3fc,#22d3ee 45%,#7c6cf0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.brand .tag{margin-top:18px;color:#8b93a7;font-size:15px;border-top:2px solid rgba(34,211,238,.25);padding-top:14px;max-width:420px}
.panel{width:440px;padding:0 56px 0 0;display:flex;flex-direction:column;justify-content:center}
.panel h2{font-size:34px;font-weight:800}
.panel .sub{color:#8b93a7;margin:6px 0 26px;font-size:13px;border-bottom:2px solid #2a2110;padding-bottom:14px}
.fld{position:relative;margin-bottom:14px}
.fld .ic{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:#8b93a7}
.fld input{width:100%;background:#eef2fb;border:none;border-radius:14px;padding:16px 46px;color:#0b1220;font-size:15px;font-weight:600;outline:none}
.fld input::placeholder{color:#90a0bd}
.fld .eye{position:absolute;right:14px;top:50%;transform:translateY(-50%);background:none;border:none;color:#5b6b86;cursor:pointer;font-size:16px}
.forgot{color:#22d3ee;font-size:13px;font-weight:600;margin:2px 0 18px;cursor:pointer;display:inline-block}
.btn{width:100%;border:none;border-radius:14px;padding:16px;color:#fff;font-size:16px;font-weight:700;cursor:pointer;background:linear-gradient(90deg,#22d3ee,#7c6cf0);box-shadow:0 12px 30px rgba(34,211,238,.35);transition:filter .2s,transform .1s}
.btn:hover{filter:brightness(1.07)} .btn:active{transform:scale(.99)}
.err{color:#ff8a8a;font-size:13px;min-height:18px;margin-bottom:8px}
@media(max-width:880px){.brand{display:none}.panel{width:100%;padding:0 28px}}
</style></head><body>
<div class="wrap">
  <div class="brand">
    <div class="logo">RJ Slot<span> Hub</span></div>
    <div class="tag">your trusted visa appointment partner</div>
  </div>
  <div class="panel">
    <h2>Sign in</h2>
    <div class="sub">Access your dashboard</div>
    <div class="err" id="err"></div>
    <div class="fld"><span class="ic">&#128100;</span><input id="u" placeholder="Username" autocomplete="username"></div>
    <div class="fld"><span class="ic">&#128274;</span><input id="p" type="password" placeholder="Password" autocomplete="current-password"><button class="eye" id="eye">&#128065;</button></div>
    <span class="forgot">Forgot Password?</span>
    <button class="btn" id="login">Login &#8594;</button>
  </div>
</div>
<script>
var eye=document.getElementById('eye'),p=document.getElementById('p');
eye.onclick=function(){p.type=p.type==='password'?'text':'password';};
function doLogin(){
  var err=document.getElementById('err');err.textContent='';
  fetch('/api/portal/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({Username:document.getElementById('u').value,Password:p.value})})
   .then(function(r){return r.json();}).then(function(d){
      if(d.ok){window.location.href=(d.role==='admin')?'/admin/users':'/portal';}
      else{err.textContent=d.error||'Login failed';}
   }).catch(function(){err.textContent='Network error';});
}
document.getElementById('login').onclick=doLogin;
p.addEventListener('keypress',function(e){if(e.key==='Enter')doLogin();});
document.getElementById('u').addEventListener('keypress',function(e){if(e.key==='Enter')doLogin();});
</script></body></html>`

const portalDashHTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RJ Slot Hub</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Quicksand:wght@500;600;700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>if(window.pdfjsLib){pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';}</script>
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',system-ui,sans-serif}
body{background:radial-gradient(1000px 500px at 80% 0%,rgba(34,211,238,.10),transparent 55%),linear-gradient(160deg,#080b16,#0b1020);color:#ece4cf;min-height:100vh}
.layout{display:flex;min-height:100vh}
.side{width:250px;background:linear-gradient(180deg,#0d1424,#070c18);border-right:1px solid rgba(34,211,238,.10);display:flex;flex-direction:column;padding:24px 16px}
.side .logo{font-size:34px;font-weight:700;font-family:Quicksand,sans-serif;padding:6px 8px 22px}
.side .logo span{background:linear-gradient(135deg,#a5f3fc,#22d3ee 45%,#7c6cf0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.side .mlabel{color:#5b6b86;font-size:11px;letter-spacing:1.5px;padding:0 10px 8px}
.nav{flex:1}
.nav a{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;color:#8b93a7;text-decoration:none;font-weight:600;font-size:14.5px;cursor:pointer;margin-bottom:4px;position:relative}
.nav a:hover{background:rgba(34,211,238,.07);color:#fff}
.nav a.active{background:linear-gradient(135deg,rgba(34,211,238,.18),rgba(124,108,240,.12));color:#fff}
.nav a.active::before{content:'';position:absolute;left:-16px;top:20%;bottom:20%;width:4px;border-radius:4px;background:linear-gradient(180deg,#22d3ee,#7c6cf0)}
.nav .sub{margin-left:14px;font-size:13px}
.logout{display:flex;align-items:center;gap:10px;padding:12px 14px;color:#8b93a7;text-decoration:none;font-weight:600;border-top:1px solid rgba(34,211,238,.08);cursor:pointer}
.logout:hover{color:#fff}
.main{flex:1;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:14px;padding:16px 26px;border-bottom:1px solid rgba(34,211,238,.08);background:rgba(16,13,8,.5)}
.top .title{font-size:18px;font-weight:700;display:flex;align-items:center;gap:10px}
.top .live{font-size:10px;font-weight:700;color:#34d399;background:rgba(52,211,153,.12);border:1px solid rgba(52,211,153,.2);padding:2px 9px;border-radius:20px}
.top .clock{margin-left:auto;color:#8b93a7;font-family:monospace;font-size:13px}
.top .who{display:flex;align-items:center;gap:10px;background:rgba(34,211,238,.06);border:1px solid rgba(34,211,238,.12);padding:6px 12px;border-radius:30px}
.top .who .av{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#22d3ee,#7c6cf0);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px}
.top .who .nm{font-weight:700;font-size:13px;line-height:1.1}.top .who .rl{font-size:10px;color:#8b93a7;letter-spacing:1px}
.content{padding:26px;flex:1}
.card{background:linear-gradient(160deg,#0e1626,#0b1120);border:1px solid rgba(34,211,238,.10);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.sec{display:none}.sec.active{display:block}
.h1{font-size:26px;font-weight:800;background:linear-gradient(135deg,#a5f3fc,#22d3ee 45%,#7c6cf0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px}
.muted{color:#8b93a7;font-size:13px}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#8b93a7;font-size:11px;letter-spacing:.8px;text-transform:uppercase;padding:14px 16px;border-bottom:1px solid rgba(34,211,238,.10)}
td{padding:13px 16px;border-bottom:1px solid rgba(34,211,238,.05);font-size:13.5px}
.empty{text-align:center;padding:50px 10px;color:#7a86a0}
.empty .big{font-size:34px}.empty .t{font-weight:700;color:#9fb0cf;margin-top:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
label{display:block;font-size:11px;letter-spacing:.6px;color:#8b93a7;text-transform:uppercase;margin:0 0 6px;font-weight:600}
input,select{width:100%;background:#0a1020;border:1px solid rgba(34,211,238,.16);border-radius:11px;padding:12px 14px;color:#ece4cf;font-size:13.5px;outline:none}
input:focus,select:focus{border-color:#7c6cf0;box-shadow:0 0 0 3px rgba(124,108,240,.12)}
select option{background:#0a1020}
.btn{border:none;border-radius:12px;padding:11px 22px;color:#fff;font-weight:700;font-size:14px;cursor:pointer;background:linear-gradient(90deg,#22d3ee,#7c6cf0);box-shadow:0 8px 22px rgba(34,211,238,.30)}
.btn:hover{filter:brightness(1.08)}
.btn-sm{padding:7px 14px;font-size:12px;border-radius:9px}
.pill{font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.2)}
.fld{margin-bottom:0}
.spin{width:120px;height:120px;border-radius:50%;border:4px solid rgba(34,211,238,.15);border-top-color:#22d3ee;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:800;color:#9fb0cf;animation:rot 4s linear infinite;margin:0 auto}
@keyframes rot{to{transform:rotate(360deg)}}
.row-actions{display:flex;gap:6px}
</style></head><body>
<div class="layout">
  <div class="side">
    <div class="logo">RJ Slot<span> Hub</span></div>
    <div class="mlabel">MENU</div>
    <div class="nav">
      <a id="nav-pay" class="active" onclick="showSec('pay')">&#128202; Payment Hub</a>
      <a id="nav-file" onclick="showSec('entries')">&#128193; File Manager</a>
      <a class="sub" id="nav-entries" onclick="showSec('entries')">&#128203; Entries</a>
      <a class="sub" id="nav-add" onclick="showSec('add')">&#10133; Add New</a>
      <a id="nav-phone" onclick="showSec('phone')">&#128222; Phone List</a>
    </div>
    <a class="logout" href="/logout">&#8594;] Logout</a>
  </div>
  <div class="main">
    <div class="top">
      <div class="title" id="secTitle">&#128202; Payment Hub <span class="live" id="liveBadge" style="display:none">&#9679; LIVE</span></div>
      <div class="clock" id="clock"></div>
      <div class="who"><div class="av" id="av">U</div><div><div class="nm" id="nm">USER</div><div class="rl" id="rl">USER</div></div></div>
    </div>
    <div class="content">
      <!-- PAYMENT HUB -->
      <div class="sec active" id="sec-pay">
        <div class="card" style="padding:50px 20px;text-align:center" id="payBox">
          <div class="spin" id="paySpin">5</div>
          <div class="muted" id="payMsg" style="margin-top:18px">No payments yet — auto-refreshing</div>
        </div>
      </div>
      <!-- ENTRIES -->
      <div class="sec" id="sec-entries">
        <div class="card" style="padding:0;overflow:hidden">
          <table><thead><tr><th>#</th><th>PHONE</th><th>PASSWORD</th><th>APPT. ID</th><th>MISSION</th><th>PAY</th><th>TIME</th><th></th></tr></thead>
          <tbody id="entriesBody"></tbody></table>
          <div class="empty" id="entriesEmpty"><div class="big">&#128203;</div><div class="t">No Entries Yet</div><div class="muted">Switch to "Add New" to create entries</div></div>
        </div>
      </div>
      <!-- ADD NEW -->
      <div class="sec" id="sec-add">
        <div class="card" style="padding:24px">
          <div class="h1" style="font-size:20px">&#10133; New Entry</div>
          <div class="muted" id="lockMsg" style="margin:6px 0 18px"></div>
          <div class="grid2">
            <div><label>Phone Number (11 digits)</label><input id="f-phone" placeholder="01XXXXXXXXX"></div>
            <div><label>IVAC Password</label><input id="f-pass" type="password" placeholder="Password"></div>
            <div><label>IVAC Registered Email</label><input id="f-email" placeholder="email@gmail.com"></div>
            <div><label>Appointment ID (optional)</label><input id="f-appt" placeholder="e.g. 2369ab0e-..."></div>
          </div>
          <div class="grid4" style="margin-top:14px">
            <div><label>Mission</label><select id="f-mission"><option value="">-- Select --</option><option>Dhaka</option><option>Chittagong</option><option>Khulna</option><option>Rajshahi</option><option>Sylhet</option></select></div>
            <div><label>Type</label><select id="f-type"><option value="">-- Select --</option><option>Medical</option><option>Entry</option><option>Double Entry</option><option>Student</option><option>Business</option><option>Tourist</option></select></div>
            <div><label>BGD Files</label><select id="f-bgd"><option value="">-- Select --</option><option>1</option><option>2</option><option>3</option><option>4</option></select></div>
            <div><label>Who Will Pay?</label><select id="f-pay"><option value="">-- Select --</option><option value="admin">Admin Pay</option><option value="self">Self Pay</option></select></div>
          </div>
          <div class="grid4" style="margin-top:14px">
            <div><label>Primary PDF (required)</label><input id="f-pdf1" type="file" accept="application/pdf" onchange="validatePdf('f-pdf1')"><div id="st-f-pdf1" class="pdfst"></div></div>
            <div><label>Applicant 2 PDF</label><input id="f-pdf2" type="file" accept="application/pdf" onchange="validatePdf('f-pdf2')"><div id="st-f-pdf2" class="pdfst"></div></div>
            <div><label>Applicant 3 PDF</label><input id="f-pdf3" type="file" accept="application/pdf" onchange="validatePdf('f-pdf3')"><div id="st-f-pdf3" class="pdfst"></div></div>
            <div><label>Applicant 4 PDF</label><input id="f-pdf4" type="file" accept="application/pdf" onchange="validatePdf('f-pdf4')"><div id="st-f-pdf4" class="pdfst"></div></div>
          </div>
          <div class="muted" style="margin-top:6px;font-size:12px">&#9432; Same PDF duibar dile block hobe. Registration date 30 din over hole "Expired" — nebe na.</div>
          <div style="margin-top:14px"><label>Username</label><input id="f-user" readonly></div>
          <div style="text-align:right;margin-top:18px"><button class="btn" id="saveEntry">Save Entry</button></div>
        </div>
      </div>
      <!-- PHONE LIST -->
      <div class="sec" id="sec-phone">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <input id="phSearch" placeholder="Search name or phone..." style="max-width:360px" oninput="renderPhones()">
          <button class="btn btn-sm" onclick="addPhone()">&#10133; Add</button>
        </div>
        <div class="h1">Phone List</div>
        <div class="muted" id="phCount" style="margin-bottom:14px">0 records</div>
        <div class="card" style="padding:0;overflow:hidden">
          <table><thead><tr><th>USER</th><th>PHONE</th><th>CONFIRM DATE</th><th>REMAINING</th><th></th></tr></thead>
          <tbody id="phonesBody"></tbody></table>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
var me={username:'',role:'user'};
var phonesCache=[];
function pad(n){return n<10?'0'+n:''+n;}
function tickClock(){var d=new Date();var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];var h=d.getHours(),ap=h>=12?'PM':'AM';h=h%12;if(h===0)h=12;document.getElementById('clock').textContent=mo[d.getMonth()]+' '+pad(d.getDate())+', '+d.getFullYear()+'  '+pad(h)+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+' '+ap;}
setInterval(tickClock,1000);tickClock();

fetch('/api/portal/me').then(function(r){return r.json();}).then(function(d){
  me=d; document.getElementById('nm').textContent=(d.username||'USER').toUpperCase();
  document.getElementById('rl').textContent=(d.role||'user').toUpperCase();
  document.getElementById('av').textContent=(d.username||'U').substring(0,2).toUpperCase();
  var fu=document.getElementById('f-user'); if(fu) fu.value=(d.username||'').toUpperCase();
});

var titles={pay:'&#128202; Payment Hub',entries:'&#128193; File Manager',add:'&#128193; File Manager',phone:'&#128222; Phone List'};
function showSec(s){
  ['pay','entries','add','phone'].forEach(function(x){var el=document.getElementById('sec-'+x);if(el)el.classList.remove('active');});
  var sec=document.getElementById('sec-'+s); if(sec)sec.classList.add('active');
  ['pay','file','entries','add','phone'].forEach(function(x){var n=document.getElementById('nav-'+x);if(n)n.classList.remove('active');});
  var nav=document.getElementById('nav-'+(s==='add'?'add':s)); if(nav)nav.classList.add('active');
  document.getElementById('secTitle').innerHTML=titles[s]+(s==='pay'?' <span class="live">&#9679; LIVE</span>':'');
  if(s==='entries')loadEntries();
  if(s==='phone')loadPhones();
  if(s==='add')loadLock();
}

// Payment Hub auto-refresh
var paySpin=document.getElementById('paySpin'),payCount=5;
function payTick(){payCount--;if(payCount<=0){payCount=5;loadPayments();}paySpin.textContent=payCount;}
setInterval(payTick,1000);
function loadPayments(){
  fetch('/api/portal/payments').then(function(r){return r.json();}).then(function(d){
    var box=document.getElementById('payBox');
    var pays=(d.payments||[]).filter(function(p){return p.paymentUrl||p.payStatus==='done';});
    var lifeSec=d.lifetimeSec||600;
    if(pays.length===0){box.innerHTML='<div class="spin" id="paySpin">'+payCount+'</div><div class="muted" style="margin-top:18px">No payments yet — auto-refreshing</div>';paySpin=document.getElementById('paySpin');return;}
    var html='';
    window.payCopy=function(btn,url){ navigator.clipboard.writeText(url).then(function(){ var o=btn.innerHTML; btn.innerHTML='&#10003; Copied'; setTimeout(function(){btn.innerHTML=o;},1500); }); };
    // Invoice download: paste/type the 36-char transaction id → auto-downloads the
    // invoice PDF (server proxies /invoice/download with the instance's token + captcha).
    window.invoiceDL=function(entryId,inp){ var t=(inp.value||'').trim(); if(t.length<10){alert('Enter the Transaction ID');return;} window.open('/api/portal/invoiceDownload?entryId='+encodeURIComponent(entryId)+'&txrId='+encodeURIComponent(t),'_blank'); };
    // checkPaid confirms payment by looking up the RID in /invoice/all-by-user (an
    // invoice exists only after a real payment). On confirmation the row flips to
    // ✓ Done. It spends one captcha, so it runs on an explicit click (and once
    // automatically when a link has expired — the moment it matters most).
    window.checkPaid=function(entryId,btn){ if(btn){btn.disabled=true;btn.textContent='Checking…';} fetch('/api/portal/invoiceCheck?entryId='+encodeURIComponent(entryId)).then(function(r){return r.json();}).then(function(d){ if(d&&d.done){ showToast&&showToast('Payment confirmed — Done','success'); loadPayments(); } else { if(btn){btn.disabled=false;btn.textContent='✅ Check Paid';} showToast&&showToast('Not paid yet'+(d&&d.error?(' ('+d.error+')'):''),'error'); } }).catch(function(){ if(btn){btn.disabled=false;btn.textContent='✅ Check Paid';} }); };
    function ridLine(p){ return p.reservationId?('<div class="muted" style="margin-top:4px;font-family:monospace;font-size:11px">RID: '+p.reservationId+'</div>'):''; }
    // trxId input is PRE-FILLED with the reservationId (RID == trxId), but it NEVER
    // auto-downloads — invoice only downloads on an explicit button click, because the
    // RID exists before payment (before Initiate) and the invoice may not exist yet.
    function invoiceBox(p){ var rid=(p.reservationId||''); return '<div style="margin-top:8px;display:flex;gap:6px;align-items:center"><input type="text" maxlength="36" value="'+rid+'" placeholder="Transaction ID (RID) — click Invoice to download" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,\'\');" style="flex:1;min-width:0;padding:7px;font-family:monospace;font-size:12px;border:1px solid #2b3a52;border-radius:5px;background:#0d1424;color:#cbd5e1"><button class="btn btn-sm" style="background:#b45309" onclick="invoiceDL(\''+p.id+'\',this.previousElementSibling)">&#128196; Invoice</button></div>'; }
    // remaining lifetime → label
    function lifeLabel(p){
      if(!p.paymentAt) return '';
      var left=Math.floor(lifeSec-(Date.now()-new Date(p.paymentAt).getTime())/1000);
      if(left<=0) return '<span class="pill" style="background:#7f1d1d;color:#fecaca">&#9200; Expired</span>';
      var m=Math.floor(left/60),s=left%60;
      return '<span class="pill" style="background:#134e2e;color:#86efac">&#9200; '+m+':'+(s<10?'0':'')+s+' left</span>';
    }
    window.payAutoChecked = window.payAutoChecked || {};
    // checkBtn renders the "✅ Check Paid" button (only when the entry has an RID).
    function checkBtn(p){ return p.reservationId?('<button class="btn btn-sm" style="background:#166534" onclick="checkPaid(\''+p.id+'\',this)">&#9989; Check Paid</button>'):''; }
    var autoCheckList=[];
    pays.forEach(function(p){
      if(p.payStatus==='done'){html+='<div style="display:flex;justify-content:space-between;align-items:center;padding:16px;border-bottom:1px solid rgba(34,211,238,.07)"><div><b>'+p.phone+'</b><div class="muted">'+(p.mission||'')+' • '+p.createdAt+'</div>'+ridLine(p)+'</div><span class="pill">&#10003; Done</span></div>';}
      else if(p.payStatus==='expired'){html+='<div style="padding:16px;border-bottom:1px solid rgba(34,211,238,.07);text-align:left"><div style="display:flex;justify-content:space-between;align-items:center"><b>'+p.phone+'</b><div class="row-actions"><span class="pill" style="background:#7f1d1d;color:#fecaca">&#9200; Expired</span> '+checkBtn(p)+'</div></div>'+ridLine(p)+'<div class="muted" style="margin-top:6px;font-size:12px">Payment link expired — re-run Full Auto for a fresh link. Already paid? Confirm above or download invoice below:</div>'+invoiceBox(p)+'</div>';
        // auto-check ONCE per expired entry: was it actually paid before it expired?
        if(p.reservationId && !window.payAutoChecked[p.id]){ window.payAutoChecked[p.id]=1; autoCheckList.push(p.id); }
      }
      else{var purl=p.paymentUrl||''; var prev=purl.length>40?purl.substring(0,40)+'…':purl; html+='<div style="padding:16px;border-bottom:1px solid rgba(34,211,238,.07);text-align:left"><div style="display:flex;justify-content:space-between;align-items:center"><b>'+p.phone+'</b><div class="row-actions">'+lifeLabel(p)+' <button class="btn btn-sm" onclick="payCopy(this,\''+purl+'\')">&#128203; Copy</button><button class="btn btn-sm" onclick="window.open(\''+purl+'\',\'_blank\')">PayNow</button> '+checkBtn(p)+'</div></div>'+ridLine(p)+'<div class="muted" style="margin-top:6px;font-family:monospace;font-size:12px" title="'+purl+'">'+prev+'</div>'+invoiceBox(p)+'</div>';}
    });
    // fire the queued one-time auto-checks for expired links (no button element).
    autoCheckList.forEach(function(eid){ window.checkPaid(eid,null); });
    box.style.textAlign='left';box.style.padding='0';box.innerHTML=html;
  }).catch(function(){});
}
loadPayments();

// Entries
function loadEntries(){
  fetch('/api/portal/entries').then(function(r){return r.json();}).then(function(d){
    var b=document.getElementById('entriesBody'),e=document.getElementById('entriesEmpty');
    var list=d.entries||[];
    if(list.length===0){b.innerHTML='';e.style.display='block';return;}
    e.style.display='none';
    var locked=d.locked;
    b.innerHTML=list.map(function(x,i){
      var act=locked?'<span style="color:#ff8a8a;font-weight:700">&#128274; Locked</span>':'<button class="btn btn-sm" style="background:#241a3a;color:#ffb4b4" onclick="delEntry(\''+x.id+'\')">Delete</button>';
      return '<tr><td>'+(i+1)+'</td><td>'+x.phone+'</td><td>'+'•'.repeat(8)+'</td><td>'+(x.appointmentId||'-')+'</td><td>'+(x.mission||'-')+'</td><td>'+(x.payMode==='self'?'Self':'Admin')+'</td><td class="muted">'+x.createdAt+'</td><td style="text-align:right">'+act+'</td></tr>';
    }).join('');
  });
}
function delEntry(id){
  if(!confirm('Delete this entry? It will also be removed from the run pool.'))return;
  fetch('/api/portal/entries?id='+id,{method:'DELETE'}).then(function(r){return r.json();}).then(function(d){
    if(d.ok){loadEntries();}
    else if(d.error==='locked'){alert('Locked — entries cannot be deleted after 4:30 PM');loadEntries();}
    else{alert(d.error||'Failed');}
  });
}
function loadLock(){
  fetch('/api/portal/entries').then(function(r){return r.json();}).then(function(d){
    var m=document.getElementById('lockMsg');
    if(d.locked){m.innerHTML='<span style="color:#ff8a8a">&#128274; Entry add locked (after 4:30 PM)</span>';document.getElementById('saveEntry').disabled=true;document.getElementById('saveEntry').style.opacity=.5;}
    else{m.textContent='Fill the form and Save.';}
  });
}
// ---- PDF validation: duplicate (SHA-256) + 30-day registration date ----
var pdfMeta={}; // inputId -> {hash, valid, note}
var pdfPending=0; // number of PDF validations still running (Save waits for these)
var MONTHS={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
function setPdfStatus(id,msg,color){var el=document.getElementById('st-'+id);if(el){el.textContent=msg;el.style.color=color;el.style.fontSize='12px';el.style.marginTop='4px';el.style.fontWeight='600';}}
function sha256Hex(buf){return crypto.subtle.digest('SHA-256',buf).then(function(h){return Array.prototype.map.call(new Uint8Array(h),function(b){return('0'+b.toString(16)).slice(-2);}).join('');});}
function parseRegDate(text){
  var low=text.toLowerCase();
  var idx=low.indexOf('registration date');
  if(idx<0)idx=low.indexOf('web registration');
  if(idx<0)return null;
  var seg=text.slice(idx,idx+60);
  // DD Mon YYYY  (e.g. 12 Jun 2026 / 12-Jun-2026)
  var m=seg.match(/(\d{1,2})[\s\-\/]+([A-Za-z]{3,9})[\s\-\/]+(\d{4})/);
  if(m&&MONTHS[m[2].slice(0,3).toLowerCase()]!==undefined){return new Date(+m[3],MONTHS[m[2].slice(0,3).toLowerCase()],+m[1]);}
  // DD/MM/YYYY or DD-MM-YYYY
  m=seg.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
  if(m){return new Date(+m[3],+m[2]-1,+m[1]);}
  return null;
}
function validatePdf(id){
  var el=document.getElementById(id);
  pdfMeta[id]={valid:false};
  if(!el||!el.files||!el.files.length){setPdfStatus(id,'',''); pdfMeta[id]={valid:true,empty:true}; return;}
  var file=el.files[0];
  setPdfStatus(id,'⏳ Checking...','#8b93a7');
  pdfPending++; // mark this validation in-flight so Save waits for it
  var _done=function(){ pdfPending=Math.max(0,pdfPending-1); };
  file.arrayBuffer().then(function(buf){
    return sha256Hex(buf).then(function(hash){
      // duplicate check against other selected inputs
      for(var k in pdfMeta){ if(k!==id && pdfMeta[k] && pdfMeta[k].hash===hash){ throw {dup:true}; } }
      // read PDF text for registration date
      return pdfjsLib.getDocument({data:buf}).promise.then(function(pdf){
        var pages=[];for(var i=1;i<=pdf.numPages;i++)pages.push(i);
        return Promise.all(pages.map(function(n){return pdf.getPage(n).then(function(p){return p.getTextContent();}).then(function(c){return c.items.map(function(it){return it.str;}).join(' ');});})).then(function(txts){
          var full=txts.join(' ');
          var rd=parseRegDate(full);
          if(rd){
            var days=Math.floor((Date.now()-rd.getTime())/86400000);
            if(days>30){ throw {expired:true,days:days,rd:rd}; }
            pdfMeta[id]={hash:hash,valid:true,note:'reg '+days+'d'};
            setPdfStatus(id,'✅ OK ('+days+' days old)','#34d399');
          } else {
            pdfMeta[id]={hash:hash,valid:true,note:'no-date'};
            setPdfStatus(id,'✅ OK (reg date na paoa)','#fbbf24');
          }
        });
      });
    });
  }).catch(function(e){
    el.value='';
    if(e&&e.dup){ pdfMeta[id]={valid:false}; setPdfStatus(id,'❌ Duplicate — ei PDF already selected','#ff8a8a'); }
    else if(e&&e.expired){ pdfMeta[id]={valid:false}; setPdfStatus(id,'❌ EXPIRED ('+e.days+' din — 30 er beshi)','#ff8a8a'); }
    else { pdfMeta[id]={valid:false}; setPdfStatus(id,'❌ PDF poড়া gelo na','#ff8a8a'); }
  }).then(_done,_done); // decrement pending once, whether it succeeded or failed
}
function allPdfsValid(){
  if(!pdfMeta['f-pdf1']||pdfMeta['f-pdf1'].empty||!pdfMeta['f-pdf1'].hash){alert('Primary PDF obosshoi lagbe (ar valid hote hobe)');return false;}
  for(var k of ['f-pdf1','f-pdf2','f-pdf3','f-pdf4']){ if(pdfMeta[k]&&pdfMeta[k].valid===false){alert('Ekটি PDF invalid (duplicate/expired). Thik korun.');return false;} }
  return true;
}
function doSaveEntry(){
  var btn=document.getElementById('saveEntry');
  var body={Phone:document.getElementById('f-phone').value,Password:document.getElementById('f-pass').value,Email:document.getElementById('f-email').value,AppointmentID:document.getElementById('f-appt').value,Mission:document.getElementById('f-mission').value,Type:document.getElementById('f-type').value,BGD:document.getElementById('f-bgd').value,PayMode:document.getElementById('f-pay').value};
  if(!body.Phone){alert('Phone required');return;}
  if(!allPdfsValid())return;
  if(btn)btn.disabled=true;
  fetch('/api/portal/entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){
    if(d.ok){
      uploadEntryPDFs(d.id).then(function(){
        if(btn)btn.disabled=false;
        alert('Entry saved!');document.getElementById('f-phone').value='';document.getElementById('f-pass').value='';document.getElementById('f-email').value='';document.getElementById('f-appt').value='';
        ['f-pdf1','f-pdf2','f-pdf3','f-pdf4'].forEach(function(x){var el=document.getElementById(x);if(el)el.value='';setPdfStatus(x,'','');});
        pdfMeta={};
        showSec('entries');
      }).catch(function(){ if(btn)btn.disabled=false; alert('Files upload holo na — abar try korun'); });
    }
    else{ if(btn)btn.disabled=false; alert(d.error||'Failed'); }
  }).catch(function(){ if(btn)btn.disabled=false; alert('Save failed — network issue, abar try korun'); });
}
document.getElementById('saveEntry').onclick=function(){
  // A PDF may still be validating in the background (hash + registration-date read).
  // Clicking Save too fast made allPdfsValid() see an unready pdfMeta → save silently
  // aborted → instance never created. So WAIT for pending validations first.
  if(pdfPending>0){
    var btn=document.getElementById('saveEntry');
    if(btn){btn.disabled=true;}
    var waited=0;
    var iv=setInterval(function(){
      waited+=100;
      if(pdfPending<=0||waited>15000){ clearInterval(iv); if(btn)btn.disabled=false; doSaveEntry(); }
    },100);
    return;
  }
  doSaveEntry();
};

// upload the selected applicant PDFs to the entry's file store (primary first)
function uploadEntryPDFs(entryId){
  var slots=[['f-pdf1','primary',1],['f-pdf2','app2',0],['f-pdf3','app3',0],['f-pdf4','app4',0]];
  var chain=Promise.resolve();
  slots.forEach(function(s){
    var el=document.getElementById(s[0]);
    if(el && el.files && el.files.length){
      chain=chain.then(function(){
        var fd=new FormData();fd.append('file',el.files[0]);
        var q='entryId='+encodeURIComponent(entryId)+'&slot='+s[1]+(s[2]?'&primary=1':'');
        return fetch('/api/portal/uploadFile?'+q,{method:'POST',body:fd}).then(function(r){return r.json();});
      });
    }
  });
  return chain;
}

// Phones
function loadPhones(){fetch('/api/portal/phones').then(function(r){return r.json();}).then(function(d){phonesCache=d.phones||[];renderPhones();});}
function renderPhones(){
  var q=(document.getElementById('phSearch').value||'').toLowerCase();
  var list=phonesCache.filter(function(p){return (p.user+p.phone).toLowerCase().indexOf(q)>=0;});
  document.getElementById('phCount').innerHTML='<b>'+list.length+'</b> records';
  document.getElementById('phonesBody').innerHTML=list.map(function(p){return '<tr><td><b>'+p.user+'</b></td><td style="font-family:monospace">'+p.phone+'</td><td>'+p.confirmDate+'</td><td><span class="pill">'+p.status+'</span></td><td style="text-align:right"><button class="btn btn-sm" style="background:#243049" onclick="delPhone(\''+p.id+'\')">&#10005;</button></td></tr>';}).join('');
}
function addPhone(){var u=prompt('User name:');if(!u)return;var ph=prompt('Phone:');if(!ph)return;var cd=prompt('Confirm date (DD/MM/YYYY):')||'';fetch('/api/portal/phones',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({User:u,Phone:ph,ConfirmDate:cd})}).then(function(){loadPhones();});}
function delPhone(id){if(!confirm('Delete?'))return;fetch('/api/portal/phones?id='+id,{method:'DELETE'}).then(function(){loadPhones();});}
</script></body></html>`

const portalAdminHTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RJ Slot Hub — User Management</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Quicksand:wght@500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;font-family:'Inter',system-ui,sans-serif}
body{background:radial-gradient(1000px 500px at 80% 0%,rgba(34,211,238,.10),transparent 55%),linear-gradient(160deg,#080b16,#0b1020);color:#ece4cf;min-height:100vh;padding:30px}
.wrap{max-width:920px;margin:0 auto}
.top{display:flex;align-items:center;gap:14px;margin-bottom:22px}
.logo{font-size:32px;font-weight:700;font-family:Quicksand,sans-serif}.logo span{background:linear-gradient(135deg,#a5f3fc,#22d3ee 45%,#7c6cf0);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.top .right{margin-left:auto;display:flex;gap:8px}
.card{background:linear-gradient(160deg,#0e1626,#0b1120);border:1px solid rgba(34,211,238,.10);border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:22px;margin-bottom:20px}
.card h3{font-size:16px;font-weight:700;margin-bottom:16px;color:#22d3ee}
.row{display:grid;grid-template-columns:1fr 1fr 160px auto;gap:12px;align-items:end}
label{display:block;font-size:11px;letter-spacing:.6px;color:#8b93a7;text-transform:uppercase;margin:0 0 6px;font-weight:600}
input,select{width:100%;background:#0a1020;border:1px solid rgba(34,211,238,.16);border-radius:11px;padding:12px 14px;color:#ece4cf;font-size:14px;outline:none}
input:focus,select:focus{border-color:#7c6cf0;box-shadow:0 0 0 3px rgba(124,108,240,.12)}
.btn{border:none;border-radius:11px;padding:12px 22px;color:#fff;font-weight:700;font-size:14px;cursor:pointer;background:linear-gradient(90deg,#22d3ee,#7c6cf0);box-shadow:0 8px 22px rgba(34,211,238,.30)}
.btn:hover{filter:brightness(1.08)}
.btn-ghost{background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.15);color:#9fb0cf}
.btn-sm{padding:7px 13px;font-size:12px;border-radius:9px}
table{width:100%;border-collapse:collapse}
th{text-align:left;color:#8b93a7;font-size:11px;letter-spacing:.8px;text-transform:uppercase;padding:12px 14px;border-bottom:1px solid rgba(34,211,238,.10)}
td{padding:12px 14px;border-bottom:1px solid rgba(34,211,238,.05);font-size:13.5px}
.pill{font-size:11px;font-weight:700;padding:3px 11px;border-radius:20px}
.pill.admin{background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.2)}
.pill.user{background:rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.2)}
.link{background:#0a1020;border:1px dashed rgba(34,211,238,.25);border-radius:10px;padding:12px 14px;color:#22d3ee;font-family:monospace;display:flex;align-items:center;gap:10px;justify-content:space-between}
.msg{font-size:13px;min-height:18px;margin-top:8px}
@media(max-width:700px){.row{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <div class="top">
    <div class="logo">RJ Slot<span> Hub</span> &nbsp;<span style="font-size:14px;color:#8b93a7">User Management</span></div>
    <div class="right">
      <a class="btn btn-ghost btn-sm" href="/">&#128202; Bot Dashboard</a>
      <a class="btn btn-ghost btn-sm" href="/logout">&#8594;] Logout</a>
    </div>
  </div>

  <div class="card">
    <h3>&#10133; Create User</h3>
    <div class="row">
      <div><label>Username</label><input id="u" placeholder="e.g. uzzal"></div>
      <div><label>Password</label><input id="p" placeholder="password"></div>
      <div><label>Role</label><select id="r"><option value="user">User</option><option value="admin">Admin</option></select></div>
      <div><button class="btn" onclick="createUser()">Create</button></div>
    </div>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <h3>&#128279; Login link to share with users</h3>
    <div class="link"><span id="loginLink"></span><button class="btn btn-sm" onclick="copyLink()">Copy</button></div>
    <div class="muted" style="color:#8b93a7;font-size:12px;margin-top:8px">User-কে এই link + তার username/password দিন। (PC-তে চালালে public access-এর জন্য Cloudflare Tunnel লাগবে।)</div>
  </div>

  <div class="card" style="padding:0;overflow:hidden">
    <table><thead><tr><th>USERNAME</th><th>ROLE</th><th>CREATED</th><th></th></tr></thead><tbody id="ub"></tbody></table>
  </div>
</div>
<script>
document.getElementById('loginLink').textContent=window.location.origin+'/login';
function copyLink(){navigator.clipboard.writeText(window.location.origin+'/login');var m=document.getElementById('msg');m.style.color='#34d399';m.textContent='Login link copied!';}
function load(){
  fetch('/api/portal/users').then(function(r){return r.json();}).then(function(d){
    document.getElementById('ub').innerHTML=(d.users||[]).map(function(x){
      return '<tr><td><b>'+x.username+'</b></td><td><span class="pill '+x.role+'">'+x.role.toUpperCase()+'</span></td><td class="muted" style="color:#8b93a7">'+(x.createdAt||'')+'</td><td style="text-align:right">'+(x.username==='admin'?'':'<button class="btn btn-sm" style="background:#241a3a" onclick="delUser(\''+x.username+'\')">Delete</button>')+'</td></tr>';
    }).join('');
  });
}
function createUser(){
  var u=document.getElementById('u').value.trim(),p=document.getElementById('p').value,r=document.getElementById('r').value;
  var m=document.getElementById('msg');
  if(!u||!p){m.style.color='#ff8a8a';m.textContent='Username & password required';return;}
  fetch('/api/portal/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({Username:u,Password:p,Role:r})})
   .then(function(rs){return rs.json();}).then(function(d){
     if(d.ok){m.style.color='#34d399';m.textContent='✅ User "'+u+'" created. Share login link + these credentials.';document.getElementById('u').value='';document.getElementById('p').value='';load();}
     else{m.style.color='#ff8a8a';m.textContent=d.error||'Failed';}
   });
}
function delUser(name){if(!confirm('Delete user '+name+'?'))return;fetch('/api/portal/users?username='+encodeURIComponent(name),{method:'DELETE'}).then(function(){load();});}
load();
</script></body></html>`
