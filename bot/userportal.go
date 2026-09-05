package main

// ============================================================================
//  ivacSlot — USER PORTAL (Phase 1)
//  Self-contained multi-user layer: login + session + per-user entries +
//  phone list + payment hub shell. Wires into main() with RegisterUserPortal().
//  Admin creates users; users log in at /login and manage their own entries.
//  (Phase 2 will turn entries into runnable admin instances + live payment.)
// ============================================================================

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	portalUsersFile   = "portal_users.json"
	portalEntriesFile = "portal_entries.json"
	portalPhonesFile  = "portal_phones.json"
	portalSalt        = "ivacslot_v1_salt"
)

type portalUser struct {
	Username  string `json:"username"`
	PassHash  string `json:"passHash"`
	Role      string `json:"role"` // admin | user
	CreatedAt string `json:"createdAt"`
}

type portalEntry struct {
	ID            string `json:"id"`
	Owner         string `json:"owner"`
	Phone         string `json:"phone"`
	Password      string `json:"password"`
	Email         string `json:"email"`
	AppointmentID string `json:"appointmentId"`
	Mission       string `json:"mission"`
	Type          string `json:"type"`
	BGD           string `json:"bgd"`
	PayMode       string `json:"payMode"` // admin | self
	InstanceID    int    `json:"instanceId"`
	PaymentURL    string `json:"paymentUrl"`
	ReservationID string `json:"reservationId"` // RID — shown in the payment hub
	PaymentAt     string `json:"paymentAt"`     // RFC3339 when the payment URL was generated (for the lifetime countdown)
	PayStatus     string `json:"payStatus"`     // pending | ready | done | expired
	CreatedAt     string `json:"createdAt"`
}

// PaymentLifetimeSec is how long a generated dg-epay payment URL stays usable.
// After this the hub shows the link as ⏰ Expired.
const PaymentLifetimeSec = 600 // 10 minutes

type portalPhone struct {
	ID          string `json:"id"`
	Owner       string `json:"owner"`
	User        string `json:"user"`
	Phone       string `json:"phone"`
	ConfirmDate string `json:"confirmDate"`
	Status      string `json:"status"`
}

var (
	pUsers    []portalUser
	pEntries  []portalEntry
	pPhones   []portalPhone
	pMu       sync.Mutex
	pSessions = map[string]string{} // token -> username
	pSessMu   sync.Mutex
)

// ---- persistence ----
func portalLoad() {
	pMu.Lock()
	defer pMu.Unlock()
	if b, err := os.ReadFile(portalUsersFile); err == nil {
		json.Unmarshal(b, &pUsers)
	}
	if b, err := os.ReadFile(portalEntriesFile); err == nil {
		json.Unmarshal(b, &pEntries)
	}
	if b, err := os.ReadFile(portalPhonesFile); err == nil {
		json.Unmarshal(b, &pPhones)
	}
	if len(pUsers) == 0 {
		// default admin: admin / admin123
		pUsers = append(pUsers, portalUser{Username: "admin", PassHash: portalHash("admin123"), Role: "admin", CreatedAt: portalNow()})
		portalSaveUsersLocked()
		fmt.Println("👤 [Portal] Default admin created → admin / admin123 (change it!)")
	}
}
func portalSaveUsersLocked()   { b, _ := json.MarshalIndent(pUsers, "", "  "); os.WriteFile(portalUsersFile, b, 0644) }
func portalSaveEntriesLocked() { b, _ := json.MarshalIndent(pEntries, "", "  "); os.WriteFile(portalEntriesFile, b, 0644) }
func portalSavePhonesLocked()  { b, _ := json.MarshalIndent(pPhones, "", "  "); os.WriteFile(portalPhonesFile, b, 0644) }

func portalHash(pw string) string { h := sha256.Sum256([]byte(portalSalt + pw)); return hex.EncodeToString(h[:]) }
func portalNow() string           { return time.Now().Format("2006-01-02 15:04:05") }
func portalID() string            { return fmt.Sprintf("%d", time.Now().UnixNano()) }

// ---- session helpers ----
func portalSessionUser(r *http.Request) (portalUser, bool) {
	c, err := r.Cookie("ivs_session")
	if err != nil {
		return portalUser{}, false
	}
	pSessMu.Lock()
	uname, ok := pSessions[c.Value]
	pSessMu.Unlock()
	if !ok {
		return portalUser{}, false
	}
	pMu.Lock()
	defer pMu.Unlock()
	for _, u := range pUsers {
		if u.Username == uname {
			return u, true
		}
	}
	return portalUser{}, false
}

func portalJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// ==================== HANDLERS ====================

func portalLoginPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(portalLoginHTML))
}

func portalLoginAPI(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	json.NewDecoder(r.Body).Decode(&in)
	in.Username = strings.TrimSpace(in.Username)
	pMu.Lock()
	var found *portalUser
	for i := range pUsers {
		if strings.EqualFold(pUsers[i].Username, in.Username) {
			found = &pUsers[i]
			break
		}
	}
	pMu.Unlock()
	if found == nil || found.PassHash != portalHash(in.Password) {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "Invalid username or password"})
		return
	}
	tok := portalHash(found.Username + portalID())
	pSessMu.Lock()
	pSessions[tok] = found.Username
	pSessMu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "ivs_session", Value: tok, Path: "/", HttpOnly: true, MaxAge: 86400 * 7})
	// admin lands on the admin dashboard (/); a regular user on their own portal.
	redirect := "/portal"
	if found.Role == "admin" {
		redirect = "/"
	}
	portalJSON(w, map[string]string{"ok": "1", "role": found.Role, "redirect": redirect})
}

func portalLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("ivs_session"); err == nil {
		pSessMu.Lock()
		delete(pSessions, c.Value)
		pSessMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "ivs_session", Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusFound)
}

func portalDashboard(w http.ResponseWriter, r *http.Request) {
	if _, ok := portalSessionUser(r); !ok {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(portalDashHTML))
}

func portalMe(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "not logged in"})
		return
	}
	portalJSON(w, map[string]string{"username": u.Username, "role": u.Role})
}

// portalLocked: the old 4:30 PM add/delete lock is removed — files can be added
// and deleted at any time.
func portalLocked() bool { return false }

func portalEntriesAPI(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "not logged in"})
		return
	}
	if r.Method == "POST" {
		if portalLocked() && u.Role != "admin" { // admin can add anytime; 4:30 lock is for users
			w.WriteHeader(403)
			portalJSON(w, map[string]string{"error": "Entry add locked (after 4:30 PM)"})
			return
		}
		var e portalEntry
		json.NewDecoder(r.Body).Decode(&e)
		e.ID = portalID()
		e.Owner = u.Username
		e.CreatedAt = portalNow()
		if e.PayStatus == "" {
			e.PayStatus = "pending"
		}

		// ---- Phase 2: create a runnable ADMIN instance from this entry ----
		instID := addInstance(u.Username, e.Phone, e.Password, e.Phone, "", e.Mission, e.Type, "auto")
		instancesMu.RLock()
		inst, ok := instances[instID]
		instancesMu.RUnlock()
		if ok {
			inst.mu.Lock()
			inst.Data.Owner = u.Username
			inst.Data.PortalEntryID = e.ID
			inst.Data.PayMode = e.PayMode
			if e.AppointmentID != "" {
				inst.Data.AppointmentID = e.AppointmentID
				inst.Data.HasAppointmentID = true
			}
			inst.mu.Unlock()
			saveInstancesToFile()
		}
		e.InstanceID = instID

		pMu.Lock()
		pEntries = append(pEntries, e)
		portalSaveEntriesLocked()
		pMu.Unlock()
		fmt.Printf("📥 [Portal] %s added entry → admin instance #%d (%s)\n", u.Username, instID, e.Phone)
		portalJSON(w, map[string]interface{}{"ok": "1", "id": e.ID, "instanceId": instID})
		return
	}
	if r.Method == "DELETE" {
		if portalLocked() && u.Role != "admin" {
			w.WriteHeader(403)
			portalJSON(w, map[string]string{"error": "locked"})
			return
		}
		id := r.URL.Query().Get("id")
		pMu.Lock()
		var instID int
		deleted := false
		nn := pEntries[:0]
		for _, e := range pEntries {
			if e.ID == id && (u.Role == "admin" || e.Owner == u.Username) {
				instID = e.InstanceID
				deleted = true
				continue // drop it
			}
			nn = append(nn, e)
		}
		pEntries = nn
		portalSaveEntriesLocked()
		pMu.Unlock()
		// also delete this entry's uploaded PDF folder so files don't pile up on disk.
		if deleted {
			if err := os.RemoveAll(entryFilesDir(id)); err != nil {
				fmt.Printf("⚠ [Portal] could not remove files for entry %s: %v\n", id, err)
			} else {
				fmt.Printf("🗑 [Portal] removed file folder for entry %s\n", id)
			}
		}
		// also remove the linked admin instance
		if instID != 0 {
			instancesMu.Lock()
			if inst, ok := instances[instID]; ok {
				inst.mu.Lock()
				if inst.cancel != nil {
					inst.cancel()
				}
				inst.mu.Unlock()
				delete(instances, instID)
			}
			instancesMu.Unlock()
			saveInstancesToFile()
		}
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}

	// GET own entries (admin sees all)
	pMu.Lock()
	out := []portalEntry{}
	for _, e := range pEntries {
		if u.Role == "admin" || e.Owner == u.Username {
			out = append(out, e)
		}
	}
	pMu.Unlock()
	portalJSON(w, map[string]interface{}{"locked": portalLocked(), "entries": out})
}

func portalPaymentsAPI(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "not logged in"})
		return
	}
	pMu.Lock()
	mine := []portalEntry{}
	for _, e := range pEntries {
		if u.Role == "admin" || e.Owner == u.Username {
			mine = append(mine, e)
		}
	}
	pMu.Unlock()

	// Pull LIVE payment URL/status from the linked admin instance.
	out := []portalEntry{}
	for _, e := range mine {
		if e.InstanceID != 0 {
			instancesMu.RLock()
			inst, ok := instances[e.InstanceID]
			instancesMu.RUnlock()
			if ok {
				inst.mu.Lock()
				if inst.Data.PaymentURL != "" {
					e.PaymentURL = inst.Data.PaymentURL
					e.PayStatus = "ready"
				}
				if inst.Data.ReservationID != "" {
					e.ReservationID = inst.Data.ReservationID // RID (live from instance)
				}
				if inst.Data.PaymentAt != "" {
					e.PaymentAt = inst.Data.PaymentAt // when the URL was generated (for countdown)
				}
				step := inst.Data.Step
				inst.mu.Unlock()
				if step == "COMPLETED" && e.PayStatus == "" {
					e.PayStatus = "done"
				}
			}
		}
		// mark the link expired once its lifetime has elapsed (server-side, so the UI
		// shows a consistent state even before the countdown ticks).
		if e.PaymentURL != "" && e.PaymentAt != "" && e.PayStatus != "done" {
			if t, err := time.Parse(time.RFC3339, e.PaymentAt); err == nil {
				if time.Since(t) > PaymentLifetimeSec*time.Second {
					e.PayStatus = "expired"
				}
			}
		}
		if e.PaymentURL != "" || e.PayStatus == "done" {
			out = append(out, e)
		}
	}
	portalJSON(w, map[string]interface{}{"payments": out, "lifetimeSec": PaymentLifetimeSec})
}

func portalPhonesAPI(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok {
		w.WriteHeader(401)
		portalJSON(w, map[string]string{"error": "not logged in"})
		return
	}
	if r.Method == "POST" {
		var p portalPhone
		json.NewDecoder(r.Body).Decode(&p)
		p.ID = portalID()
		p.Owner = u.Username
		if p.User == "" {
			p.User = u.Username
		}
		if p.Status == "" {
			p.Status = "Available"
		}
		pMu.Lock()
		pPhones = append(pPhones, p)
		portalSavePhonesLocked()
		pMu.Unlock()
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}
	if r.Method == "DELETE" {
		id := r.URL.Query().Get("id")
		pMu.Lock()
		nn := pPhones[:0]
		for _, p := range pPhones {
			if p.ID != id {
				nn = append(nn, p)
			}
		}
		pPhones = nn
		portalSavePhonesLocked()
		pMu.Unlock()
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}
	pMu.Lock()
	out := []portalPhone{}
	for _, p := range pPhones {
		if u.Role == "admin" || p.Owner == u.Username {
			out = append(out, p)
		}
	}
	pMu.Unlock()
	portalJSON(w, map[string]interface{}{"phones": out})
}

// admin: create / list / delete users
func portalAdminUsers(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok || u.Role != "admin" {
		w.WriteHeader(403)
		portalJSON(w, map[string]string{"error": "admin only"})
		return
	}
	if r.Method == "POST" {
		var in struct{ Username, Password, Role string }
		json.NewDecoder(r.Body).Decode(&in)
		in.Username = strings.TrimSpace(in.Username)
		if in.Username == "" || in.Password == "" {
			w.WriteHeader(400)
			portalJSON(w, map[string]string{"error": "username & password required"})
			return
		}
		if in.Role == "" {
			in.Role = "user"
		}
		pMu.Lock()
		for _, x := range pUsers {
			if strings.EqualFold(x.Username, in.Username) {
				pMu.Unlock()
				w.WriteHeader(409)
				portalJSON(w, map[string]string{"error": "user exists"})
				return
			}
		}
		pUsers = append(pUsers, portalUser{Username: in.Username, PassHash: portalHash(in.Password), Role: in.Role, CreatedAt: portalNow()})
		portalSaveUsersLocked()
		pMu.Unlock()
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}
	if r.Method == "PUT" {
		// change a password. Changing YOUR OWN account requires the OLD password to
		// verify first (so a left-open session can't silently reset it). An admin
		// resetting a DIFFERENT user's password does not need the old one.
		var in struct{ Username, OldPassword, Password string }
		json.NewDecoder(r.Body).Decode(&in)
		in.Username = strings.TrimSpace(in.Username)
		if in.Username == "" || len(in.Password) < 6 {
			w.WriteHeader(400)
			portalJSON(w, map[string]string{"error": "username & a password of at least 6 chars required"})
			return
		}
		changingSelf := strings.EqualFold(in.Username, u.Username)
		pMu.Lock()
		found := false
		for i := range pUsers {
			if strings.EqualFold(pUsers[i].Username, in.Username) {
				if changingSelf && pUsers[i].PassHash != portalHash(in.OldPassword) {
					pMu.Unlock()
					w.WriteHeader(403)
					portalJSON(w, map[string]string{"error": "old password is wrong"})
					return
				}
				pUsers[i].PassHash = portalHash(in.Password)
				found = true
				break
			}
		}
		if found {
			portalSaveUsersLocked()
		}
		pMu.Unlock()
		if !found {
			w.WriteHeader(404)
			portalJSON(w, map[string]string{"error": "user not found"})
			return
		}
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}
	if r.Method == "DELETE" {
		name := r.URL.Query().Get("username")
		pMu.Lock()
		nn := pUsers[:0]
		for _, x := range pUsers {
			if x.Username != name {
				nn = append(nn, x)
			}
		}
		pUsers = nn
		portalSaveUsersLocked()
		pMu.Unlock()
		portalJSON(w, map[string]string{"ok": "1"})
		return
	}
	pMu.Lock()
	list := []map[string]string{}
	for _, x := range pUsers {
		list = append(list, map[string]string{"username": x.Username, "role": x.Role, "createdAt": x.CreatedAt})
	}
	pMu.Unlock()
	portalJSON(w, map[string]interface{}{"users": list})
}

// admin-only User Management page
func portalAdminUsersPage(w http.ResponseWriter, r *http.Request) {
	u, ok := portalSessionUser(r)
	if !ok || u.Role != "admin" {
		http.Redirect(w, r, "/login", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(portalAdminHTML))
}

// RegisterUserPortal wires the portal routes. Call once in main().
func RegisterUserPortal() {
	portalLoad()
	http.HandleFunc("/login", portalLoginPage)
	http.HandleFunc("/portal", portalDashboard)
	http.HandleFunc("/admin/users", portalAdminUsersPage)
	http.HandleFunc("/logout", portalLogout)
	http.HandleFunc("/api/portal/login", portalLoginAPI)
	http.HandleFunc("/api/portal/me", portalMe)
	http.HandleFunc("/api/portal/entries", portalEntriesAPI)
	http.HandleFunc("/api/portal/payments", portalPaymentsAPI)
	http.HandleFunc("/api/portal/invoiceDownload", handlePortalInvoiceDownload)
	http.HandleFunc("/api/portal/phones", portalPhonesAPI)
	http.HandleFunc("/api/portal/users", portalAdminUsers)
	http.HandleFunc("/api/portal/uploadFile", handlePortalUploadFile)
	fmt.Println("🌐 [Portal] User portal ready → /login   (admin/admin123)")
}
