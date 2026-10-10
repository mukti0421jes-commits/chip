package flow

import (
	"errors"
	"strconv"
)

var (
	errStopped       = errors.New("stopped")
	errAppointment   = errors.New("appointment call failed")
	errPrimaryUpload = errors.New("primary file upload failed")
	errPartialUpload = errors.New("not all saved files uploaded")
	errOverview         = errors.New("overview check failed")
	errOverviewMismatch = errors.New("overview does not match uploaded files")
	errConfirmCenter = errors.New("confirm center failed")
	// errAppointmentExpired: the appointment is >30 days old — retrying can't fix it,
	// a NEW appointment must be created. Stops the upload sub-flow immediately.
	errAppointmentExpired = errors.New("appointment expired (>30 days) — create a new appointment and restart")
	// errAppointmentNotFound: the server keeps returning 404 "Appointment not found"
	// for upload/confirm-center — the appointment is in a stuck state (e.g. files
	// uploaded in a prior session but center never confirmed). Retrying the same
	// thing can't fix it; a NEW appointment/entry is needed. Stops immediately.
	errAppointmentNotFound = errors.New("appointment not found on server — re-create this entry (delete & add again) to get a fresh appointment")
	// errOTPWindow: the OTP verify window (OTPVerifyLifetime) elapsed without a valid
	// OTP (neither auto-fetched nor typed manually), so the instance auto-stopped. The
	// message intentionally contains "stopped" so the handler marks the instance
	// STOPPED (not FAILED). Restarting a not-yet-verified instance begins from sign-in.
	errOTPWindow = errors.New("otp verify window over — no OTP received, instance auto-stopped")

	// errTooManyAttempts: the sign-in response said "too many attempts" (server rate-
	// limit / lockout). This applies to BOTH a first-time login and a relogin. Retrying
	// or re-logging in only extends the lockout, so the instance AUTO-STOPS instead of
	// signing in again — the user restarts it manually when ready. "stopped" in the text
	// makes the handler mark the instance STOPPED (not FAILED); it is NOT a session-
	// expiry, so the auto-relogin loop does not re-run it.
	errTooManyAttempts = errors.New("signin: too many attempts — instance auto-stopped (manually restart when ready)")

	// errScanFailed: Full Auto is LIVE-ONLY. When the live bundle scan does not
	// succeed within the set try-count, the instance aborts WITHOUT any store/built-in
	// fallback (Play All is the cache path). "stopped" in the text makes the handler
	// mark the instance STOPPED (not FAILED), so restarting begins from a fresh scan.
	errScanFailed = errors.New("live scan failed — Full Auto stopped (no fallback; use Play All for cache)")

	// errSessionExpired: after sign-in/verify, a token-using step got HTTP 401 (the
	// ~15-min access token died mid-flow, e.g. during a long reserve wait). The run
	// stops so the handler can auto-off, wait, and RE-LOGIN — but ONLY before payment:
	// once Initiate succeeds RunFullAuto returns success (a payURL), never this, so an
	// instance that already initiated / paid is never auto-relogged (manual only).
	errSessionExpired = errors.New("session expired (401) — relogin needed")
)

// IsSessionExpired reports whether a RunFullAuto error is the post-auth 401 that the
// handler answers with an auto-off → wait → relogin (only pre-payment; once Initiate
// succeeds RunFullAuto returns nil, so a paid/initiated instance never hits this).
func IsSessionExpired(err error) bool { return errors.Is(err, errSessionExpired) }

// IsOTPWindow reports whether a run ended because the OTP verify window elapsed with no
// valid OTP (the instance auto-stopped, never verified). The sign-in session + its OTP
// are dead by then, so the handler clears the resume cache and the sign-in window — a
// restart then begins from a FRESH sign-in (new OTP) instead of reusing the expired
// session and re-polling for an OTP that will never arrive.
func IsOTPWindow(err error) bool { return errors.Is(err, errOTPWindow) }

func itoa(n int) string { return strconv.Itoa(n) }
