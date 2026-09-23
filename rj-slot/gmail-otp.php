<?php
/**
 * gmail-otp.php — per-profile Gmail OTP reader for RJ SLOT
 * ------------------------------------------------------------------
 * The userscript POSTs:  email=<the gmail address>&apppass=<16-char App Password>
 * We log into that Gmail over IMAP (imap.gmail.com:993 SSL), read the newest few
 * messages and pull out the OTP. Reply is the SAME shape email.php uses:
 *      success:  {"status":"success","otp":"123456"}
 *      waiting:  {"status":"pending","otp":null}
 *      error:    {"status":"error","error":"..."}
 *
 * Requirements on the server (cPanel):
 *   - PHP "imap" extension enabled (Select PHP Version → Extensions → tick "imap").
 *   - The Gmail account must have 2-Step Verification ON and an App Password created;
 *     that 16-char App Password is what the userscript sends (NOT the normal password).
 */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

function out($a) { echo json_encode($a); exit; }

// ---- inputs (POST preferred; GET allowed as a fallback) ----
$email = trim($_POST['email']   ?? $_GET['email']   ?? '');
$pass  = trim($_POST['apppass'] ?? $_GET['apppass'] ?? '');
$pass  = str_replace(' ', '', $pass);   // App Passwords are shown as "xxxx xxxx xxxx xxxx" → strip spaces

if ($email === '' || $pass === '') out(['status' => 'error', 'error' => 'email and apppass are required']);
if (!function_exists('imap_open')) out(['status' => 'error', 'error' => 'IMAP extension is not enabled on the server']);

// ---- connect to Gmail over IMAP ----
$mailbox = '{imap.gmail.com:993/imap/ssl/novalidate-cert}INBOX';
$imap = @imap_open($mailbox, $email, $pass, 0, 1);
if (!$imap) out(['status' => 'error', 'error' => 'login failed — check the App Password / IMAP. ' . imap_last_error()]);

$total = @imap_num_msg($imap);
if (!$total) { @imap_close($imap); out(['status' => 'pending', 'otp' => null]); }

// ---- pick which messages to scan (newest first) ----
// Fast path: jump straight to the newest IVAC OTP mails via IMAP search (skips unrelated inbox mail).
// Fallback: the newest 4 messages overall. This keeps each poll quick.
$otp = null;
$scan = [];
$hits = @imap_search($imap, 'FROM "ivacbd.com"');           // IVAC sender only
if (!$hits) $hits = @imap_search($imap, 'FROM "appointment.ivacbd.com"');
if ($hits && count($hits)) {
    rsort($hits, SORT_NUMERIC);                              // newest first
    $scan = array_slice($hits, 0, 4);
} else {
    for ($i = $total; $i >= max(1, $total - 3); $i--) $scan[] = $i;   // newest 4 overall
}

foreach ($scan as $i) {
    if ($otp) break;
    // grab a readable text body: prefer the plain-text part, fall back to whole body
    $body = @imap_fetchbody($imap, $i, 1.1);   // text/plain in multipart
    if (!$body) $body = @imap_fetchbody($imap, $i, 1);
    if (!$body) $body = @imap_body($imap, $i);
    if (!$body) continue;
    $body = quoted_printable_decode($body);
    $body = preg_replace('/<[^>]+>/', ' ', $body);   // strip any HTML tags so digits are reachable

    // 0) IVAC sends the OTP as SPELLED-OUT WORDS, e.g. "Zero-One-Zero-Eight-Three-Four" (= 010834).
    //    Find a run of 4–8 number-words (separated by - / space / dot) and convert to digits.
    $wmap = ['zero'=>'0','one'=>'1','two'=>'2','three'=>'3','four'=>'4','five'=>'5','six'=>'6','seven'=>'7','eight'=>'8','nine'=>'9'];
    if (preg_match('/(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:[\s\-.,]+(?:zero|one|two|three|four|five|six|seven|eight|nine)){3,7}/i', $body, $wm)) {
        $parts = preg_split('/[\s\-.,]+/', $wm[0]);
        $digits = '';
        foreach ($parts as $p) { $lp = strtolower(trim($p)); if (isset($wmap[$lp])) $digits .= $wmap[$lp]; }
        if (strlen($digits) >= 4 && strlen($digits) <= 8) { $otp = $digits; break; }
    }
    // 1) strongest: a number that sits right after an OTP-ish word
    if (preg_match('/(?:otp|code|verification|verify|pin|password|sequence)[^0-9]{0,25}(\d{4,8})/i', $body, $m)) { $otp = $m[1]; break; }
    // 2) otherwise: a standalone 6-digit block (the usual OTP length)
    if (preg_match('/(?<!\d)(\d{6})(?!\d)/', $body, $m)) { $otp = $m[1]; break; }
    // 3) last resort: any 4–8 digit run
    if (preg_match('/(?<!\d)(\d{4,8})(?!\d)/', $body, $m)) { $otp = $m[1]; break; }
}
@imap_close($imap);

if ($otp) out(['status' => 'success', 'otp' => $otp]);
out(['status' => 'pending', 'otp' => null]);
