// upload-expose.js — make the bundle's file-upload action callable from the page,
// so the headless walk can fire a REAL /file/upload-file POST (and thereby capture
// x-sec-runtime-state, which only rides the upload request) WITHOUT driving the
// site's custom upload modal.
//
// GENERIC (no per-bundle names hardcoded): it finds the function that contains the
// "x-sec-runtime-state" header literal (that IS the upload action), brace-matches
// its body, and appends `globalThis.__ivacUploadFn = <thatFunction>`. The walk then
// calls it with a synthetic { file, webFileNumber, isPrimary, turnstileToken }.
'use strict';

// find the `function NAME(` declaration whose body contains index `pos`.
function enclosingFunction(src, pos) {
  // scan backwards for the nearest "function <name>(" whose matching "}" is after pos
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m, best = null;
  while ((m = re.exec(src))) {
    if (m.index > pos) break;
    best = { name: m[1], start: m.index, braceAt: src.indexOf('{', m.index) };
    // keep the LAST one that starts before pos; verify containment below
  }
  // walk candidates from nearest-before-pos outward until one's body encloses pos
  const cands = [];
  const re2 = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  while ((m = re2.exec(src))) {
    if (m.index > pos) break;
    cands.push({ name: m[1], braceAt: re2.lastIndex - 1 });
  }
  for (let i = cands.length - 1; i >= 0; i--) {
    const end = matchBrace(src, cands[i].braceAt);
    if (end > pos) return { name: cands[i].name, braceEnd: end };
  }
  return null;
}

// given the index of a "{", return the index of its matching "}" (string/template
// aware; good enough for javascript-obfuscator output).
function matchBrace(src, openIdx) {
  let depth = 0, quote = null, esc = false;
  for (let j = openIdx; j < src.length; j++) {
    const c = src[j];
    if (quote) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = null;
    } else {
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return j; }
    }
  }
  return -1;
}

// Returns { src, ok, name } — src with the exposure appended after the upload
// action, or the original src unchanged when the action can't be located.
function injectUploadExposure(src) {
  const pos = src.indexOf('x-sec-runtime-state');
  if (pos < 0) return { src, ok: false, name: '' };
  const fn = enclosingFunction(src, pos);
  if (!fn || fn.braceEnd < 0) return { src, ok: false, name: '' };
  const inject = ';try{globalThis.__ivacUploadFn=' + fn.name + '}catch(_e){}';
  return { src: src.slice(0, fn.braceEnd + 1) + inject + src.slice(fn.braceEnd + 1), ok: true, name: fn.name };
}

module.exports = { injectUploadExposure, enclosingFunction, matchBrace };
