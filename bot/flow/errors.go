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
)

func itoa(n int) string { return strconv.Itoa(n) }
