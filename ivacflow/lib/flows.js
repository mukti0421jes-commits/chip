'use strict';
// ═══════════════════════════════════════════════════════════════════
//  FLOWS — শুধু UI চালায়। কোন request কোন ধাপ, সেটা ঠিক করে
//  probe.js-এর classify() — URL দেখে। তাই এখানে কোনো নাম বসানো নেই।
//
//  scenario গুলো router-এর gate অনুযায়ী ভাগ করা (probe.js --map দেখুন):
//    uploadFile                      → file-upload / mission পেজ
//    fileUploadConfirmed + slotOpen  → time-slot পেজ
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

async function findButton(page, re) {
    for (const btn of await page.$$('button')) {
        const text = ((await btn.textContent()) || '').trim();
        if (re.test(text)) return { el: btn, text: text };
    }
    return null;
}

async function clickButton(page, re, waitMs) {
    const hit = await findButton(page, re);
    if (!hit) return false;
    await hit.el.click({ force: true }).catch(function () {});
    await page.waitForTimeout(waitMs || 1500);
    return true;
}

// trigger আসতে বা enabled হতে দেরি হতে পারে (আগের বাছাইয়ের API-র অপেক্ষায়)
async function waitForEnabled(page, re, tries) {
    for (let i = 0; i < (tries || 10); i++) {
        const hit = await findButton(page, re);
        if (hit && !(await hit.el.isDisabled())) return hit;
        await page.waitForTimeout(500);
    }
    return null;
}

// dropdown = custom button; চাপলে option গুলোও button হয়ে ফোটে।
//   তালিকা API থেকে আসে, তাই option দেরিতে ফুটতে পারে — কয়েকবার দেখি
async function pickOption(page, triggerRe, optionRe) {
    const trigger = await waitForEnabled(page, triggerRe);
    if (!trigger) return false;
    await trigger.el.click({ force: true }).catch(function () {});
    for (let attempt = 0; attempt < 6; attempt++) {
        await page.waitForTimeout(500);
        const option = await findButton(page, optionRe);
        if (!option) continue;
        await option.el.click({ force: true }).catch(function () {});
        await page.waitForTimeout(1400);
        return true;
    }
    return false;
}

function anchored(text) {
    return new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function tempPdf() {
    const file = path.join(os.tmpdir(), 'probe-BGD0001.pdf');
    fs.writeFileSync(file, '%PDF-1.4\n%probe\n');
    return file;
}

// ── SIGN IN → VERIFY OTP ─────────────────────────────────────────
async function runAuth(session, state) {
    const page = session.page;
    const inputs = await page.$$('input:not([type=file])');
    if (inputs[0]) await inputs[0].fill(state.phone).catch(function () {});
    if (inputs[1]) await inputs[1].fill(state.password).catch(function () {});
    await clickButton(page, /sign ?in|log ?in/i, 3000);

    const boxes = await page.$$('input:not([type=file])');
    if (boxes.length >= 6) {
        for (let i = 0; i < 6; i++) await boxes[i].fill(state.otp[i]).catch(function () {});
    } else if (boxes.length) {
        await boxes[0].fill(state.otp).catch(function () {});
    }
    await page.waitForTimeout(600);
    await clickButton(page, /verify/i, 2500);
}

// ── ফাইল আপলোড। index 0 = primary, 1 = family ────────────────────
//   কোন ঘরটা খোলা থাকবে সেটা overview response ঠিক করে (probe.js দেখুন)
async function runUpload(session, index) {
    const page = session.page;
    const inputs = await page.$$('input[type=file]');
    const target = inputs[index] || inputs[0];
    if (!target) return;
    await target.setInputFiles(tempPdf()).catch(function () {});
    await page.waitForTimeout(2800);
    await clickButton(page, /confirm all/i, 2500);
}

// ── CONFIG: mission + IVAC center বেছে confirm ────────────────────
async function runConfig(session, state) {
    const page = session.page;
    await pickOption(page, /select a mission/i, anchored(state.mission));
    await pickOption(page, /ivac cent/i, anchored(state.ivacCenter.slice(0, 4)));
    await clickButton(page, /confirm mission/i, 2500);
}

// ── AMOUNT (লোডেই) → RESERVE → PAY ───────────────────────────────
// তারিখ বাছার ঘর সাইট দু-রকম করে দেখায়, আর build-ভেদে বদলায়:
//   পুরোনো : "pick up a date" → তালিকায় "26-12-2031"
//   নতুন   : সরাসরি ক্যালেন্ডার → শুধু দিনের সংখ্যা (1…31)
// দুটোই চেষ্টা করি, নইলে UI বদলালেই flow ঐখানে থেমে যেত আর তার নিচের
//   ধাপগুলো (RESERVE / PAYMENT AMOUNT / PAY) কখনো ধরাই পড়ত না।
async function pickDate(page) {
    await clickButton(page, /pick up a date/i, 900);
    if (await clickButton(page, /^\d{2}-\d{2}-\d{4}$/, 900)) return true;
    // ক্যালেন্ডার — শেষ দিকের খোলা দিনটা নিই (শুরুর দিনগুলো প্রায়ই বন্ধ)
    for (let round = 0; round < 3; round++) {
        const days = [];
        for (const btn of await page.$$('button')) {
            const text = ((await btn.textContent()) || '').trim();
            if (!/^\d{1,2}$/.test(text)) continue;
            if (await btn.isDisabled()) continue;
            days.push(btn);
        }
        if (days.length) {
            await days[days.length - 1].click({ force: true }).catch(function () {});
            await page.waitForTimeout(1400);
            return true;
        }
        // এই মাসে খোলা দিন নেই — পরের মাসে যাই
        if (!(await clickButton(page, /^›$|^>$|next/i, 900))) break;
    }
    return false;
}

async function runSlot(session) {
    const page = session.page;
    await pickDate(page);
    // সময় বাছার ধাপ সব build-এ থাকে না ("time will be provided in the
    //   Payment Invoice") — না থাকলে বাদ দিয়ে এগোই, আটকে থাকি না।
    await clickButton(page, /\d{1,2}:\d{2}\s*(AM|PM)/i, 900);
    await clickButton(page, /continue booking/i, 3500);
    await clickButton(page, /continue payment/i, 3000);
}

module.exports = { runAuth, runUpload, runConfig, runSlot };
