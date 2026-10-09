'use strict';
// ═══════════════════════════════════════════════════════════════════
//  CIPHERBOX — raw captcha token কে সাইট যেভাবে ঢাকে, সেভাবেই ঢাকে।
//
//  নিজে করে না — bundle-এর নিজের function দিয়েই করায়। তাই obfuscation
//  বা algorithm নিয়ে আমাদের কিছু জানার দরকার নেই, আর ফল সাইটের সাথে
//  হুবহু মেলে।
//
//  একটা পেজ গরম রাখা হয় (bundle লোড করা), তাই প্রতি token-এ মিলিসেকেন্ড।
//  পেজ না থাকলে চুপচাপ raw ফেরত দেয় না — পরিষ্কার করে "পারিনি" বলে।
// ═══════════════════════════════════════════════════════════════════
const harness = require('./harness');
const flows = require('./flows');

// role অনুযায়ী কোন পেজে গিয়ে কোন flow চালালে সাইট নিজে cipher ডাকে
const FLOW = {
    signin:  { route: '/signin', authed: false, drive: flows.runAuth,
               gate: { uploadFile: true, fileUploadConfirmed: false, slotOpen: false, paymentConfirm: false, uploadEnd: false } },
    reserve: { route: '/appointment/time-slot', authed: true, drive: flows.runSlot, booked: true,
               gate: { uploadFile: true, fileUploadConfirmed: true, slotOpen: true, paymentConfirm: false, uploadEnd: true } }
};

// সাইটের payload-এ captcha যে নামে যায়
const CAPTCHA_KEY = /^(c|captcha|cf.?token|turnstile)$/i;

// token আর সম্ভাব্য ঢাকা মানের কতটা শুরু/শেষ হুবহু মেলে।
//   cipher আংশিক ও format-preserving, তাই আসল ঢাকা মানের সাথে token-এর
//   একটা অংশ সবসময়ই এক থাকে; অসম্পর্কিত field-এ থাকে না।
function _affinity(a, b) {
    let head = 0, tail = 0;
    while (head < a.length && a[head] === b[head]) head++;
    while (tail < a.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return head + tail;
}

class CipherBox {
    constructor() {
        this.browser = null;
        this.page = null;
        this.server = null;
        this.bundlePath = '';
        this.ready = false;
        this.error = '';
        this.starting = null;
        // ⚠️ bundle-এ ২০টার মতো একই আকারের function থাকে (encrypt/decrypt-এর
        //    ১০টা সংস্করণ)। যেটা প্রথমে "কাজ করে" সেটা ধরে নিলে ভুল হয় —
        //    মেপে দেখা গেছে প্রথমটা decryptText, অথচ সাইট ডাকে encryptText।
        //    তাই warm-up-এ নিশ্চিত পথ দিয়ে মিলিয়ে সঠিকটা পিন করে রাখি।
        this.pin = null;          // { idx, secret, startAt, length, name }
        this.calibrating = null;
    }

    // নতুন bundle এলে আগেরটা ফেলে নতুন করে গরম করি
    async use(bundlePath) {
        if (this.bundlePath === bundlePath && this.ready) return true;
        await this.close();          // পিনও এখানেই মুছে যায়
        this.bundlePath = bundlePath;
        this.starting = this._start(bundlePath);
        return this.starting;
    }

    async _start(bundlePath) {
        let chromium;
        try { chromium = require('playwright-core').chromium; }
        catch (_) { this.error = 'playwright-core নেই'; return false; }
        try {
            this.server = await harness.startServer(bundlePath);
            this.browser = await chromium.launch({
                executablePath: harness.findChromium(), args: ['--no-sandbox']
            });
            const session = await harness.openSession(this.browser, this.server.port,
                harness.makeState({}), { route: '/signin', authed: false, marker: 'x' });
            this.page = session.page;
            this._session = session;
            // bundle-এর cipher function গুলো ধরা পড়তে সময় দিই
            for (let i = 0; i < 20; i++) {
                const n = await this.page.evaluate(function () {
                    return (window.__probeCipher || []).length;
                }).catch(function () { return 0; });
                if (n) { this.ready = true; this.error = ''; return true; }
                await this.page.waitForTimeout(500);
            }
            this.error = 'bundle-এ cipher function পাওয়া গেল না';
            return false;
        } catch (e) {
            this.error = e.message;
            return false;
        }
    }

    // raw token → সাইট যেমন পাঠাত তেমন ঢাকা token।
    //   config-এর secret লাগে না — সব মান এই bundle-এর নিজের ডাক থেকেই আসে,
    //   তাই config বাসি হলেও এখানে ভুল ঢোকার পথ নেই।
    //   আগে দ্রুত পথ (পিন করা function), না পারলে নিশ্চিত পথ (flow)।
    // ── ক্যালিব্রেশন ────────────────────────────────────────────────
    // একবার নিশ্চিত পথে (flow) একটা token ঢাকিয়ে সত্যিটা জেনে নিই, তারপর
    //   কোন function + কোন মান দিয়ে ডাকলে হুবহু ঐ ফল আসে সেটা খুঁজে পিন করি।
    //   এরপর সব token তাৎক্ষণিক আর নির্ভুল।
    async calibrate(role) {
        if (this.pin) return true;
        if (this.calibrating) return this.calibrating;
        const self = this;
        this.calibrating = (async function () {
            const probe = 'ivacCAL' + Date.now() + 'z'.repeat(40);
            const truth = await self.encryptByFlow(probe, role || 'signin');
            if (!truth.ok) { self.error = 'ক্যালিব্রেশন: ' + truth.error; return false; }
            // সাইট নিজে যে মান দিয়ে ডেকেছিল সেগুলোই ব্যবহার করি
            const seen = await self.page.evaluate(function () {
                const c = (window.__probeCipherCalls || []);
                return c.length ? c[c.length - 1] : null;
            }).catch(function () { return null; });
            const args = seen && seen.secret
                ? { secret: seen.secret, startAt: seen.startAt | 0, length: seen.length | 0 }
                : null;
            if (!args) { self.error = 'ক্যালিব্রেশন: সাইটের ডাক দেখা গেল না'; return false; }
            const hit = await self.page.evaluate(function (a) {
                const list = window.__probeCipher || [];
                for (let i = 0; i < list.length; i++) {
                    let r;
                    try { r = list[i].fn(a.text, a.secret, a.startAt, a.length); } catch (_) { continue; }
                    if (r === a.truth) return { idx: i, name: list[i].name };
                }
                return null;
            }, { text: probe, truth: truth.value, secret: args.secret, startAt: args.startAt, length: args.length });
            if (!hit) { self.error = 'ক্যালিব্রেশন: মিলে যায় এমন function পাওয়া গেল না'; return false; }
            self.pin = { idx: hit.idx, name: hit.name, secret: args.secret,
                         startAt: args.startAt, length: args.length, bundle: self.bundlePath };
            self.error = '';
            return true;
        })();
        const r = await this.calibrating;
        this.calibrating = null;
        return r;
    }

    async encrypt(token, role) {
        if (this.starting) { await this.starting; this.starting = null; }
        if (!this.ready || !this.page) return { ok: false, error: this.error || 'প্রস্তুত নয়' };

        // পিন অন্য bundle-এর হলে বাতিল — দ্বিতীয় স্তরের পাহারা
        if (this.pin && this.pin.bundle !== this.bundlePath) this.pin = null;
        if (!this.pin) await this.calibrate(role);

        if (this.pin) {
            try {
                const out = await this.page.evaluate(function (a) {
                    const f = (window.__probeCipher || [])[a.idx];
                    if (!f) return null;
                    try { return f.fn(a.text, a.secret, a.startAt, a.length); } catch (_) { return null; }
                }, { idx: this.pin.idx, text: String(token), secret: this.pin.secret,
                     startAt: this.pin.startAt, length: this.pin.length });
                if (typeof out === 'string' && out.length === String(token).length) {
                    return { ok: true, value: out, via: 'fast' };
                }
            } catch (_) {}
        }

        // পিন না থাকলে বা কাজ না করলে — নিশ্চিত পথ
        const f = await this.encryptByFlow(token, role);
        if (f.ok) return f;
        return { ok: false, error: (this.error ? this.error + ' · ' : '') + 'flow: ' + f.error };
    }

    // ── নিশ্চিত পথ ─────────────────────────────────────────────────
    // secret লাগে না। token-টাকেই turnstile-এর জায়গায় বসিয়ে সাইটের নিজের
    //   flow চালাই, আর যাওয়ার পথে ঢাকা `c` তুলে নিই। ধীর (কয়েক সেকেন্ড)
    //   কিন্তু অব্যর্থ — সাইট নিজে যা পাঠাত হুবহু তাই।
    //   request আটকে দেওয়া হয়, তাই token সার্ভারে যায় না, নষ্টও হয় না।
    async encryptByFlow(token, role) {
        const f = FLOW[role];
        if (!f) return { ok: false, error: 'এই role-এ flow নেই: ' + role };
        if (!this.browser || !this.server) return { ok: false, error: this.error || 'প্রস্তুত নয়' };
        let session = null;
        try {
            const state = harness.makeState({ gate: f.gate, booked: !!f.booked });
            session = await harness.openSession(this.browser, this.server.port, state,
                { route: f.route, authed: f.authed, marker: token });
            await f.drive(session, state);
            await session.page.waitForTimeout(500);

            // ① সবচেয়ে নিশ্চিত — সাইট নিজে যে ডাকটা দিয়েছে সেটাই পড়ি।
            //    text === আমাদের token, তাই ভুল field তোলার সুযোগ নেই।
            const called = await session.page.evaluate(function (t) {
                const c = (window.__probeCipherCalls || []);
                for (let i = c.length - 1; i >= 0; i--) {
                    if (c[i] && c[i].text === t && typeof c[i].out === 'string') return c[i].out;
                }
                return null;
            }, String(token)).catch(function () { return null; });
            if (typeof called === 'string' && called.length === String(token).length) {
                return { ok: true, value: called, via: 'flow' };
            }

            // ② ডাক ধরা না পড়লে request body থেকে তুলি — কিন্তু "যেকোনো একই
            //    দৈর্ঘ্যের field" নয়। cipher format-preserving ও আংশিক, তাই
            //    ঢাকা মানের শুরু/শেষ token-এর সাথেই মেলে। এই পরীক্ষা ছাড়া
            //    ঠিক ঐ দৈর্ঘ্যের অন্য field (যেমন ফোন নম্বর) উঠে আসতে পারে —
            //    আর তখন নীরবে ভুল captcha যেত।
            const tok = String(token);
            let best = null;
            for (const r of session.requests) {
                if (!r.body) continue;
                let parsed;
                try { parsed = JSON.parse(r.body); } catch (_) { continue; }
                for (const k of Object.keys(parsed || {})) {
                    const v = parsed[k];
                    if (typeof v !== 'string' || v.length !== tok.length || v === tok) continue;
                    const score = _affinity(tok, v) + (CAPTCHA_KEY.test(k) ? 1000 : 0);
                    if (score > 0 && (!best || score > best.score)) best = { value: v, score: score };
                }
            }
            if (best) return { ok: true, value: best.value, via: 'flow' };
            return { ok: false, error: 'flow চলল, কিন্তু ঢাকা token পাওয়া গেল না' };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            try { if (session) await session.close(); } catch (_) {}
        }
    }

    async close() {
        try { if (this._session) await this._session.close(); } catch (_) {}
        try { if (this.browser) await this.browser.close(); } catch (_) {}
        try { if (this.server) this.server.close(); } catch (_) {}
        this.browser = this.page = this.server = this._session = null;
        this.ready = false;
        // ⚠️ পিন ঐ bundle-এরই — নতুন bundle এলে এটা মুছতেই হবে, নইলে
        //    পুরোনো secret/function দিয়ে নতুন bundle-এ ঢাকা হতো (নীরবে ভুল)।
        this.pin = null;
        this.calibrating = null;
        this.error = '';
    }
}

module.exports = { CipherBox };
