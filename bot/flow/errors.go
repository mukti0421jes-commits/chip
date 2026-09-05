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
)

func itoa(n int) string { return strconv.Itoa(n) }
