/* RJ Automation — full-page driver (invitation → undertaking/consent + signature) */
import * as pdfjsLib from './lib/pdf.min.mjs';
import { parseInvitation, isMinor, buildPatientUndertaking, buildAttendantUndertaking, buildParentalConsent, MISSIONS } from './docgen.js';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
const full = (p) => ((p.given || '') + ' ' + (p.surname || '')).trim();
function status(m, ok = true) { const e = $('status'); e.textContent = m; e.className = ok ? 'ok' : 'err'; }

let data = null, mission = 'BGDD';
const sigStore = {};          // key → signature dataURL
let sigTarget = null;         // {key, onDone}

// ---------------- invitation import ----------------
async function importInvitation(file) {
  try {
    status('⏳ ইনভাইটেশন পড়া হচ্ছে...');
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      let line = '', ly = null;
      for (const it of tc.items) { const y = Math.round(it.transform[5]); if (ly !== null && Math.abs(y - ly) > 3) { text += line + '\n'; line = ''; } line += it.str; ly = y; }
      text += line + '\n';
    }
    data = parseInvitation(text);
    status('✔ পড়া হয়েছে।');
    openMission();
  } catch (e) { console.error(e); status('✘ পড়া যায়নি: ' + e.message, false); }
}

(function wireDrop() {
  const d = $('drop'), inp = $('invFile');
  d.onclick = () => inp.click();
  inp.onchange = () => { if (inp.files[0]) importInvitation(inp.files[0]); };
  ['dragenter', 'dragover'].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => d.addEventListener(ev, (e) => { e.preventDefault(); d.classList.remove('drag'); }));
  d.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) importInvitation(f); });
})();

// ---------------- modal helpers ----------------
function showModal(html) { $('modalBody').innerHTML = html; $('overlay').classList.remove('hidden'); }
function closeModal() { $('overlay').classList.add('hidden'); }
$('overlay').addEventListener('click', (e) => { if (e.target === $('overlay')) closeModal(); });

// ---------------- STEP 1: mission ----------------
const MLABEL = { BGDD: ['Dhaka', 'High Commission of India', '🏛'], BGDC: ['Chittagong', 'Assistant High Commission of India', '🏢'], BGDR: ['Rajshahi', 'Assistant High Commission of India', '🏢'], BGDS: ['Sylhet', 'Assistant High Commission of India', '🏢'], BGDK: ['Khulna', 'Assistant High Commission of India', '🏢'] };
function openMission() {
  let opts = '';
  for (const k in MLABEL) opts += `<div class="opt${k === mission ? ' sel' : ''}" data-m="${k}"><div class="ic">${MLABEL[k][2]}</div><div><div class="nm">${MLABEL[k][0]} <span class="tag">${k === 'BGDD' ? 'HCI' : 'AHCI'}</span></div><div class="d">${MLABEL[k][1]}</div></div><div class="go">${k === mission ? '✓' : ''}</div></div>`;
  showModal(`<div class="step">STEP 1 OF 2 · Select Mission</div><h2>কোন মিশনে আবেদন করতে চান?</h2><div class="sub">নিচ থেকে সঠিক মিশন বেছে নিন</div>${opts}<div class="row-end"><button id="mClose">✕ Close</button><button class="btn-primary" id="mNext">✓ Next →</button></div>`);
  $('modalBody').querySelectorAll('.opt').forEach((o) => o.onclick = () => { mission = o.dataset.m; openMission(); });
  $('mClose').onclick = closeModal;
  $('mNext').onclick = openApplicants;
}

// ---------------- STEP 2: applicants ----------------
function openApplicants() {
  const list = [{ p: data.patient, role: 'রোগী · Patient', kind: 'patient' }];
  data.attendants.forEach((a, i) => list.push({ p: a, role: 'অ্যাটেনডেন্ট ' + (i + 1) + ' · ' + (isMinor(a) ? 'MINOR' : 'ATTENDANT'), kind: 'attendant' }));
  let rows = '';
  list.forEach((x, i) => { rows += `<div class="opt" data-i="${i}"><div class="ic">${x.kind === 'patient' ? '🩺' : '🧾'}</div><div><div class="d">${x.role}</div><div class="nm">${full(x.p)}</div></div><div class="go">→</div></div>`; });
  showModal(`<div class="step">Select Applicant</div><h2>কার জন্য ফাইল বানাবেন?</h2><div class="sub">🏥 ${data.hospital.name || ''} — ${[data.hospital.city, data.hospital.state].filter(Boolean).join(', ')}</div>${rows}<div class="row-end"><button id="aBack">← মিশন</button><button id="aClose">✕ Close</button></div>`);
  $('modalBody').querySelectorAll('.opt').forEach((o) => o.onclick = () => openPrepare(list[+o.dataset.i]));
  $('aBack').onclick = openMission; $('aClose').onclick = closeModal;
}

// ---------------- STEP 3: prepare & download ----------------
function ageLabel(p) { return ''; }
function openPrepare(item) {
  const p = item.p, minor = item.kind === 'attendant' && isMinor(p);
  const docs = [];
  if (item.kind === 'patient') docs.push({ title: 'Undertaking | অঙ্গিকারনামা', build: (sig) => buildPatientUndertaking(data, mission, sig), sigKey: 'p:' + p.passport, sigLabel: 'আবেদনকারীর স্বাক্ষর' });
  else {
    docs.push({ title: 'Undertaking | অঙ্গিকারনামা', build: (sig) => buildAttendantUndertaking(data, p, mission, sig), sigKey: 'a:' + p.passport, sigLabel: 'আবেদনকারীর স্বাক্ষর' });
    if (minor) docs.push({ title: 'Parental Consent | সম্মতিপত্র', consent: true, sigKey: 'c:' + p.passport, sigLabel: 'বাবা ও মা-র স্বাক্ষর' });
  }
  let body = `<button id="pBack" style="margin-bottom:10px">← Go Back</button><div class="step">Prepare & Download</div><h2>${full(p)} ${minor ? '<span class="pill">MINOR</span>' : ''}</h2><div class="sub">${item.role}</div>`;
  docs.forEach((d, i) => {
    body += `<div class="card" style="margin:10px 0;padding:14px">
      <div style="font-weight:700">${d.title} <span class="tag" style="background:#fee2e2;color:#b91c1c">REQUIRED</span></div>
      <div class="note" style="margin:6px 0">${d.consent ? 'বাবা-মা দুজনের স্বাক্ষর যোগ করতে পারেন (ঐচ্ছিক)।' : 'স্বাক্ষর যোগ করুন (ঐচ্ছিক) — নাহলে ফাঁকা থাকবে।'}</div>
      <div class="rowbtns" data-doc="${i}">
        ${d.consent
          ? `<button class="sig-btn" data-sig="${d.sigKey}:father"><span class="ic">✍</span>বাবার স্বাক্ষর</button>
             <button class="sig-btn" data-sig="${d.sigKey}:mother"><span class="ic">✍</span>মায়ের স্বাক্ষর</button>`
          : `<button class="sig-btn" data-sig="${d.sigKey}" data-src="upload"><span class="ic">＋</span>স্বাক্ষর আপলোড</button>
             <button class="sig-btn" data-sig="${d.sigKey}" data-src="qr"><span class="ic">▦</span>QR স্ক্যান</button>
             <button class="sig-btn" data-sig="${d.sigKey}" data-src="cam"><span class="ic">📷</span>ক্যামেরা</button>`}
      </div>
      <div class="note sigstate" data-key="${d.sigKey}" style="margin-top:6px"></div>
      <button class="btn-primary btn-block" style="margin-top:10px" data-gen="${i}">↓ ${d.consent ? 'সম্মতিপত্র' : 'অঙ্গিকারনামা'} তৈরি ও ডাউনলোড</button>
    </div>`;
  });
  showModal(body);
  $('pBack').onclick = openApplicants;
  // signature source buttons
  $('modalBody').querySelectorAll('.sig-btn').forEach((b) => b.onclick = () => {
    const key = b.dataset.sig; const src = b.dataset.src || 'upload';
    openSignature(key, src, () => refreshSigStates());
  });
  // consent father/mother buttons default to upload menu
  $('modalBody').querySelectorAll('[data-sig*=":father"],[data-sig*=":mother"]').forEach((b) => b.onclick = () => {
    chooseSource((src) => openSignature(b.dataset.sig, src, () => refreshSigStates()));
  });
  // generate
  $('modalBody').querySelectorAll('[data-gen]').forEach((b) => b.onclick = () => {
    const d = docs[+b.dataset.gen];
    try {
      let res;
      if (d.consent) res = buildParentalConsent(data, p, mission, { father: sigStore[d.sigKey + ':father'], mother: sigStore[d.sigKey + ':mother'] });
      else res = d.build(sigStore[d.sigKey]);
      res.doc.save(res.filename);
      status('✔ ' + res.filename + ' ডাউনলোড হয়েছে।');
    } catch (e) { console.error(e); status('✘ তৈরি হয়নি: ' + e.message, false); }
  });
  refreshSigStates();
}
function refreshSigStates() {
  $('modalBody') && $('modalBody').querySelectorAll('.sigstate').forEach((el) => {
    const base = el.dataset.key;
    const keys = [base, base + ':father', base + ':mother'].filter((k) => sigStore[k]);
    el.innerHTML = keys.length ? '✔ স্বাক্ষর যোগ হয়েছে: ' + keys.map((k) => k.split(':').pop()).join(', ') : '';
    el.className = 'note sigstate' + (keys.length ? ' ok' : '');
  });
}
function chooseSource(cb) {
  showModal(`<div class="step">স্বাক্ষর</div><h2>স্বাক্ষর কীভাবে দেবেন?</h2><div class="rowbtns" style="margin-top:10px"><button class="sig-btn" id="csUp"><span class="ic">＋</span>আপলোড</button><button class="sig-btn" id="csQr"><span class="ic">▦</span>QR স্ক্যান</button><button class="sig-btn" id="csCam"><span class="ic">📷</span>ক্যামেরা</button></div><div class="row-end"><button id="csClose">✕</button></div>`);
  $('csUp').onclick = () => cb('upload'); $('csQr').onclick = () => cb('qr'); $('csCam').onclick = () => cb('cam'); $('csClose').onclick = closeModal;
}

// ---------------- signature: source acquisition ----------------
const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = 'image/*';
function openSignature(key, src, onDone) {
  sigTarget = { key, onDone };
  if (src === 'upload') {
    fileInput.value = '';
    fileInput.onchange = () => { const f = fileInput.files[0]; if (f) loadImageToEditor(URL.createObjectURL(f)); };
    fileInput.click();
  } else { openCamera(src); }
}

// camera / QR
let camStream = null, camRAF = null;
function openCamera(mode) {
  const qr = mode === 'qr';
  showModal(`<div class="step">${qr ? 'QR স্ক্যান' : 'ক্যামেরা'}</div><h2>${qr ? 'স্বাক্ষরের QR স্ক্যান করুন' : 'স্বাক্ষরের ছবি তুলুন'}</h2><div class="sub">${qr ? 'QR-এ থাকা ছবি/লিঙ্ক স্ক্যান হলে এডিটরে আসবে।' : 'সাদা কাগজে করা স্বাক্ষর ক্যামেরায় ধরুন।'}</div><video id="cam" playsinline></video><canvas id="camCanvas" class="hidden"></canvas><div class="row-end" style="margin-top:10px">${qr ? '' : '<button class="btn-primary" id="camShot">📸 তুলুন</button>'}<button id="camClose">✕ বন্ধ</button></div><div class="note" id="camHint" style="margin-top:6px"></div>`);
  const video = $('cam');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((s) => {
    camStream = s; video.srcObject = s; video.play();
    if (qr) scanQR(video);
  }).catch((e) => { $('camHint').textContent = '✘ ক্যামেরা চালু হয়নি: ' + e.message; });
  $('camClose').onclick = () => { stopCamera(); closeModal(); };
  const shot = $('camShot');
  if (shot) shot.onclick = () => {
    const c = $('camCanvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    stopCamera(); loadImageToEditor(c.toDataURL('image/png'));
  };
}
function scanQR(video) {
  const c = $('camCanvas');
  const tick = () => {
    if (!camStream) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      c.width = video.videoWidth; c.height = video.videoHeight;
      const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const code = window.jsQR && window.jsQR(img.data, img.width, img.height);
      if (code && code.data) {
        const t = code.data.trim();
        $('camHint').textContent = '✔ QR: ' + t.slice(0, 60);
        if (/^data:image\//.test(t) || /^https?:\/\/.*\.(png|jpe?g|webp)(\?|$)/i.test(t)) { stopCamera(); loadImageToEditor(t); return; }
        if (/^https?:\/\//.test(t)) { stopCamera(); loadImageToEditor(t); return; }
        // অন্য টেক্সট — লেখা দেখাই, ব্যবহারকারী চাইলে বন্ধ করবে
      }
    }
    camRAF = requestAnimationFrame(tick);
  };
  camRAF = requestAnimationFrame(tick);
}
function stopCamera() { if (camRAF) cancelAnimationFrame(camRAF); camRAF = null; if (camStream) { camStream.getTracks().forEach((t) => t.stop()); camStream = null; } }

// ---------------- signature editor ----------------
let baseCanvas = null;     // current working image (crop baked in)
let cropRect = null;       // {x,y,w,h} in display coords
function loadImageToEditor(srcUrl) {
  closeModal();
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    baseCanvas = document.createElement('canvas'); baseCanvas.width = img.naturalWidth; baseCanvas.height = img.naturalHeight;
    baseCanvas.getContext('2d').drawImage(img, 0, 0);
    ['sRot', 'sBri', 'sCon', 'sWhite'].forEach((id) => { $(id).value = 0; });
    updateSliderLabels();
    $('sigOverlay').classList.remove('hidden');
    renderSig(); initCrop();
    $('sigHint').textContent = '';
  };
  img.onerror = () => { $('sigOverlay').classList.remove('hidden'); baseCanvas = null; $('sigHint').textContent = '✘ ছবি লোড হয়নি (QR লিঙ্ক হলে ইন্টারনেট/অনুমতি লাগতে পারে)।'; };
  img.src = srcUrl;
}
function updateSliderLabels() { $('vRot').textContent = $('sRot').value + '°'; $('vBri').textContent = $('sBri').value; $('vCon').textContent = $('sCon').value; $('vWhite').textContent = $('sWhite').value; }

// রেন্ডার → transformed canvas (natural res)
function renderCanvas() {
  if (!baseCanvas) return null;
  const rot = (+$('sRot').value) * Math.PI / 180;
  const bw = baseCanvas.width, bh = baseCanvas.height;
  const cos = Math.abs(Math.cos(rot)), sin = Math.abs(Math.sin(rot));
  const nw = Math.ceil(bw * cos + bh * sin), nh = Math.ceil(bw * sin + bh * cos);
  const out = document.createElement('canvas'); out.width = nw; out.height = nh;
  const ctx = out.getContext('2d');
  ctx.translate(nw / 2, nh / 2); ctx.rotate(rot); ctx.drawImage(baseCanvas, -bw / 2, -bh / 2);
  // brightness/contrast/white-transparent
  const bri = +$('sBri').value, con = +$('sCon').value, wt = +$('sWhite').value;
  const cf = (259 * (con + 255)) / (255 * (259 - con));
  const im = ctx.getImageData(0, 0, nw, nh); const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = cf * (d[i] - 128) + 128 + bri, g = cf * (d[i + 1] - 128) + 128 + bri, b = cf * (d[i + 2] - 128) + 128 + bri;
    r = r < 0 ? 0 : r > 255 ? 255 : r; g = g < 0 ? 0 : g > 255 ? 255 : g; b = b < 0 ? 0 : b > 255 ? 255 : b;
    if (wt > 0 && r >= 255 - wt && g >= 255 - wt && b >= 255 - wt) d[i + 3] = 0;
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  ctx.putImageData(im, 0, 0);
  return out;
}
let displayScale = 1;
function renderSig() {
  const rc = renderCanvas(); if (!rc) return;
  const disp = $('sigCanvas'); const wrapW = Math.min(480, $('sigWrap').clientWidth || 480);
  displayScale = Math.min(1, wrapW / rc.width);
  disp.width = Math.round(rc.width * displayScale); disp.height = Math.round(rc.height * displayScale);
  const ctx = disp.getContext('2d'); ctx.clearRect(0, 0, disp.width, disp.height); ctx.drawImage(rc, 0, 0, disp.width, disp.height);
}
['sRot', 'sBri', 'sCon', 'sWhite'].forEach((id) => $(id).addEventListener('input', () => { updateSliderLabels(); renderSig(); }));

// crop box drag/resize (display coords)
function initCrop() {
  const box = $('cropBox'), disp = $('sigCanvas');
  cropRect = { x: disp.width * 0.1, y: disp.height * 0.1, w: disp.width * 0.8, h: disp.height * 0.8 };
  drawCrop();
  box.classList.remove('hidden');
  let mode = null, sx, sy, orig;
  const start = (e, m) => { mode = m; const pt = evtPt(e); sx = pt.x; sy = pt.y; orig = { ...cropRect }; e.preventDefault(); e.stopPropagation(); };
  box.onpointerdown = (e) => { if (e.target.dataset.h) return; start(e, 'move'); box.setPointerCapture(e.pointerId); };
  box.querySelector('.h').onpointerdown = (e) => { start(e, 'br'); box.querySelector('.h').setPointerCapture(e.pointerId); };
  const move = (e) => {
    if (!mode) return; const pt = evtPt(e); const dx = pt.x - sx, dy = pt.y - sy;
    if (mode === 'move') { cropRect.x = clamp(orig.x + dx, 0, disp.width - cropRect.w); cropRect.y = clamp(orig.y + dy, 0, disp.height - cropRect.h); }
    else { cropRect.w = clamp(orig.w + dx, 20, disp.width - cropRect.x); cropRect.h = clamp(orig.h + dy, 20, disp.height - cropRect.y); }
    drawCrop();
  };
  box.onpointermove = move; box.querySelector('.h').onpointermove = move;
  const end = () => { mode = null; };
  box.onpointerup = end; box.querySelector('.h').onpointerup = end;
}
function evtPt(e) { const r = $('sigCanvas').getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function drawCrop() {
  const box = $('cropBox'); const cw = $('sigCanvas');
  box.style.left = cw.offsetLeft + cropRect.x + 'px'; box.style.top = cw.offsetTop + cropRect.y + 'px';
  box.style.width = cropRect.w + 'px'; box.style.height = cropRect.h + 'px';
}
$('cropApply').onclick = () => {
  const rc = renderCanvas(); if (!rc) return;
  const sx = cropRect.x / displayScale, sy = cropRect.y / displayScale, sw = cropRect.w / displayScale, sh = cropRect.h / displayScale;
  const out = document.createElement('canvas'); out.width = Math.round(sw); out.height = Math.round(sh);
  out.getContext('2d').drawImage(rc, sx, sy, sw, sh, 0, 0, out.width, out.height);
  baseCanvas = out;
  ['sRot'].forEach((id) => $(id).value = 0); updateSliderLabels();
  renderSig(); initCrop();
};
$('cropReset').onclick = () => { ['sRot', 'sBri', 'sCon', 'sWhite'].forEach((id) => $(id).value = 0); updateSliderLabels(); renderSig(); initCrop(); };
$('sigCancel').onclick = () => { $('sigOverlay').classList.add('hidden'); };
$('sigDone').onclick = () => {
  const rc = renderCanvas(); if (!rc || !sigTarget) { $('sigOverlay').classList.add('hidden'); return; }
  sigStore[sigTarget.key] = rc.toDataURL('image/png');
  $('sigOverlay').classList.add('hidden');
  const cb = sigTarget.onDone; sigTarget = null; if (cb) cb();
};

// ---------------- tool buttons ----------------
const PAGES = { editpdf: 'pdf-edit.html', compress: 'pdf-compress.html', split: 'pdf-split.html', img2pdf: 'img2pdf.html', merge: 'pdf-merge.html', invoice: 'invoice.html' };
const WA = 'https://wa.me/qr/N3UUJFA3B6YUF1'; // uzzaldutto60
const LINKS = { wa: WA, wagroup: WA };
document.querySelectorAll('[data-todo]').forEach((b) => b.addEventListener('click', () => {
  const t = b.dataset.todo;
  if (PAGES[t]) { window.open(chrome.runtime.getURL(PAGES[t]), '_blank'); return; }
  if (LINKS[t]) { window.open(LINKS[t], '_blank', 'noopener'); return; }
  status('⏳ এই ফিচারটি শীঘ্রই যোগ হবে (' + t + ')।');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}));
