package server

import (
	"ai-summarizer/go-api/auth"
	"ai-summarizer/go-api/models"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// Two-step sign-in with an authenticator app: setting it up, signing in with it, recovery codes, switching it off.

const testTwoFactorKey = "0123456789abcdef0123456789abcdef"

func withTwoFactorKey(t *testing.T) {
	t.Helper()
	t.Setenv(auth.EncryptionKeyEnv, base64.StdEncoding.EncodeToString([]byte(testTwoFactorKey)))
}

// codeAt is the code an authenticator app shows `steps` 30-second steps from now.
func codeAt(t *testing.T, secret string, steps int64) string {
	t.Helper()
	code, err := auth.TOTPCode(secret, auth.TOTPStep(time.Now())+steps)
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// switchedOn takes a signed-in account all the way through setting up two-step sign-in. It returns its secret and the
// recovery codes. (The code that finishes the set-up is the current one, so the next ones that work are in the steps after.)
func switchedOn(t *testing.T, a *app, cl *client) (secret string, recovery []string) {
	t.Helper()
	r := cl.post("/account/two-factor/setup", map[string]string{"password": goodPass})
	if r.Status != http.StatusOK || r.Str("secret") == "" || !strings.HasPrefix(r.Str("otpauthUrl"), "otpauth://totp/Inkling:") {
		t.Fatalf("setup: %d %s", r.Status, r.Body)
	}
	secret = r.Str("secret")
	r = cl.post("/account/two-factor/enable", map[string]string{"code": codeAt(t, secret, 0)})
	if r.Status != http.StatusOK {
		t.Fatalf("enable: %d %s", r.Status, r.Body)
	}
	for _, c := range r.JSON()["recoveryCodes"].([]any) {
		recovery = append(recovery, c.(string))
	}
	return secret, recovery
}

// passwordStep signs in with the password only, as the second step's first half.
func passwordStep(a *app, email string) (*client, reply) {
	cl := a.newClient()
	return cl, cl.post("/login", map[string]string{"email": email, "password": goodPass})
}

func signedIn(cl *client) bool { return cl.get("/auth/me").Status == http.StatusOK }

func TestTwoStepSignInIsOnlyOfferedWhereThereIsAKeyToProtectItsSecretsWith(t *testing.T) {
	a := newApp(t)
	t.Setenv(auth.EncryptionKeyEnv, "")
	cl, _ := a.newUser()
	me := cl.get("/auth/me").JSON()["user"].(map[string]any)
	if me["twoFactorAvailable"] != false || me["twoFactorEnabled"] != false {
		t.Errorf("without a key: %v", me)
	}
	if r := cl.post("/account/two-factor/setup", map[string]string{"password": goodPass}); r.Status != http.StatusServiceUnavailable || r.Str("code") != "two_factor_unavailable" {
		t.Errorf("setup without a key: %d %s", r.Status, r.Body)
	}
	withTwoFactorKey(t)
	if me := cl.get("/auth/me").JSON()["user"].(map[string]any); me["twoFactorAvailable"] != true {
		t.Errorf("with a key: %v", me)
	}
}

func TestSettingUpNeedsThePasswordAndAGoodCodeFromTheApp(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()

	if r := cl.post("/account/two-factor/setup", map[string]string{"password": "wrong-Password-1"}); r.Status != http.StatusForbidden || r.Str("code") != "wrong_password" {
		t.Errorf("setup with a wrong password: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/two-factor/enable", map[string]string{"code": "123456"}); r.Status != http.StatusConflict || r.Str("code") != "two_factor_not_started" {
		t.Errorf("enable before setup: %d %s", r.Status, r.Body)
	}
	r := cl.post("/account/two-factor/setup", map[string]string{"password": goodPass})
	secret := r.Str("secret")
	if r.Status != http.StatusOK || len(secret) != 32 {
		t.Fatalf("setup: %d %s", r.Status, r.Body)
	}
	// started is not on: signing in still needs only the password, and the account says so
	if _, login := passwordStep(a, email); login.JSON()["twoFactorRequired"] == true {
		t.Error("two-step was asked for before it was switched on")
	}
	if r := cl.post("/account/two-factor/enable", map[string]string{"code": "000000"}); r.Status != http.StatusUnauthorized || r.Str("code") != "invalid_code" {
		t.Errorf("enable with a wrong code: %d %s", r.Status, r.Body)
	}
	if u := a.userByEmail(email); u.TwoFactorEnabled() {
		t.Error("switched on by a wrong code")
	}
	r = cl.post("/account/two-factor/enable", map[string]string{"code": codeAt(t, secret, 0)})
	codes, _ := r.JSON()["recoveryCodes"].([]any)
	if r.Status != http.StatusOK || len(codes) != 10 {
		t.Fatalf("enable: %d %s", r.Status, r.Body)
	}
	if me := cl.get("/auth/me").JSON()["user"].(map[string]any); me["twoFactorEnabled"] != true {
		t.Errorf("me after enabling: %v", me)
	}
	if r := cl.post("/account/two-factor/setup", map[string]string{"password": goodPass}); r.Status != http.StatusConflict || r.Str("code") != "two_factor_enabled" {
		t.Errorf("setup again: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/two-factor/enable", map[string]string{"code": codeAt(t, secret, 1)}); r.Status != http.StatusConflict {
		t.Errorf("enable again: %d", r.Status)
	}
}

func TestTheSecretIsNotInTheDatabaseInTheClear(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, recovery := switchedOn(t, a, cl)
	stored := a.userByEmail(email).TotpSecret
	if stored == "" || strings.Contains(stored, secret) {
		t.Errorf("stored secret: %q", stored)
	}
	if opened, err := auth.OpenSecret(stored); err != nil || opened != secret {
		t.Errorf("it opens to %q, %v", opened, err)
	}
	// and the recovery codes are only hashes
	for _, code := range recovery {
		if n := count(t, a.db, "SELECT count(*) FROM recovery_codes WHERE code_hash = ?", code); n != 0 {
			t.Errorf("recovery code %q is stored as it is", code)
		}
		if n := count(t, a.db, "SELECT count(*) FROM recovery_codes WHERE code_hash = ?", auth.HashRecoveryCode(code)); n != 1 {
			t.Errorf("recovery code %q has no hash stored", code)
		}
	}
}

func TestWithTwoStepOnAPasswordIsNotEnoughToSignIn(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, _ := switchedOn(t, a, cl)

	second, r := passwordStep(a, email)
	challenge := r.Str("challenge")
	if r.Status != http.StatusOK || r.JSON()["twoFactorRequired"] != true || challenge == "" || r.JSON()["user"] != nil {
		t.Fatalf("password step: %d %s", r.Status, r.Body)
	}
	if r.cookie("session") != nil || len(r.cookies()) != 0 || signedIn(second) {
		t.Error("the password alone started a session")
	}
	if r := second.post("/auth/two-factor", map[string]string{"challenge": challenge, "code": "000000"}); r.Status != http.StatusUnauthorized || r.Str("code") != "invalid_code" {
		t.Errorf("a wrong code: %d %s", r.Status, r.Body)
	}
	if signedIn(second) {
		t.Fatal("a wrong code started a session")
	}
	r = second.post("/auth/two-factor", map[string]string{"challenge": challenge, "code": codeAt(t, secret, 1)})
	if r.Status != http.StatusOK || r.JSON()["user"] == nil || !signedIn(second) {
		t.Fatalf("the right code: %d %s", r.Status, r.Body)
	}
	// the challenge is used up
	third := a.newClient()
	if r := third.post("/auth/two-factor", map[string]string{"challenge": challenge, "code": codeAt(t, secret, 1)}); r.Status != http.StatusUnauthorized || r.Str("code") != "challenge_expired" {
		t.Errorf("a used challenge: %d %s", r.Status, r.Body)
	}
	// a wrong password still gets nothing, and no challenge
	if r := a.newClient().post("/login", map[string]string{"email": email, "password": "wrong-Password-1"}); r.Status != http.StatusUnauthorized || r.Str("challenge") != "" {
		t.Errorf("wrong password: %d %s", r.Status, r.Body)
	}
}

func TestACodeCannotBeUsedTwice(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, _ := switchedOn(t, a, cl)
	code := codeAt(t, secret, 1) // the setup used this step's code: the next one is the first that is still good

	first, r := passwordStep(a, email)
	if r := first.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "code": code}); r.Status != http.StatusOK {
		t.Fatalf("first use: %d %s", r.Status, r.Body)
	}
	second, r := passwordStep(a, email)
	if r := second.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "code": code}); r.Status != http.StatusUnauthorized {
		t.Errorf("a code that was already used: %d %s", r.Status, r.Body)
	}
	// nor is the code that finished the set-up good again
	third, r := passwordStep(a, email)
	if r := third.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "code": codeAt(t, secret, 0)}); r.Status != http.StatusUnauthorized {
		t.Errorf("the code from the set-up: %d %s", r.Status, r.Body)
	}
}

func TestTheSameCodeSentManyTimesAtOnceWorksOnce(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, _ := switchedOn(t, a, cl)
	code := codeAt(t, secret, 1)

	const tries = 24
	challenges := make([]string, tries)
	clients := make([]*client, tries)
	for i := range challenges {
		clients[i], _ = passwordStep(a, email)
		_, r := passwordStep(a, email)
		challenges[i] = r.Str("challenge")
	}
	// every request is made ready first and then they are all let go together, so they really do overlap
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := range challenges {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if r := clients[i].post("/auth/two-factor", map[string]string{"challenge": challenges[i], "code": code}); r.Status == http.StatusOK {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()
	if won != 1 {
		t.Errorf("%d of %d simultaneous uses of one code got in, want exactly 1", won, tries)
	}
}

func TestAChallengeGivesUpAfterFiveWrongCodes(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, _ := switchedOn(t, a, cl)
	second, r := passwordStep(a, email)
	challenge := r.Str("challenge")
	for i := 0; i < 5; i++ {
		if r := second.post("/auth/two-factor", map[string]string{"challenge": challenge, "code": "00000" + string(rune('0'+i))}); r.Status != http.StatusUnauthorized || r.Str("code") != "invalid_code" {
			t.Fatalf("wrong code %d: %d %s", i+1, r.Status, r.Body)
		}
	}
	// the sixth try is refused even with the right code: it would have been a million-to-one guess made patiently
	if r := second.post("/auth/two-factor", map[string]string{"challenge": challenge, "code": codeAt(t, secret, 1)}); r.Status != http.StatusUnauthorized || r.Str("code") != "challenge_expired" {
		t.Errorf("after five wrong codes: %d %s", r.Status, r.Body)
	}
	if signedIn(second) || count(t, a.db, "SELECT count(*) FROM mfa_challenges WHERE user_id = ?", a.userByEmail(email).ID) != 0 {
		t.Error("the spent challenge was kept, or a session started")
	}
}

func TestAChallengeExpires(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, _ := switchedOn(t, a, cl)
	second, r := passwordStep(a, email)
	a.db.Exec("UPDATE mfa_challenges SET expires_at = now() - interval '1 minute'")
	if r := second.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "code": codeAt(t, secret, 1)}); r.Status != http.StatusUnauthorized || r.Str("code") != "challenge_expired" {
		t.Errorf("an expired challenge: %d %s", r.Status, r.Body)
	}
	for _, body := range []map[string]string{{}, {"challenge": "nonsense", "code": "123456"}, {"challenge": r.Str("challenge")}} {
		if r := a.newClient().post("/auth/two-factor", body); r.Status != http.StatusUnauthorized {
			t.Errorf("%v: %d", body, r.Status)
		}
	}
}

func TestARecoveryCodeWorksOnceAndIsCounted(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	_, recovery := switchedOn(t, a, cl)

	first, r := passwordStep(a, email)
	r = first.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": strings.ToUpper(recovery[0])})
	if r.Status != http.StatusOK || r.JSON()["recoveryCodesLeft"] != float64(9) || !signedIn(first) {
		t.Fatalf("a recovery code: %d %s", r.Status, r.Body)
	}
	second, r := passwordStep(a, email)
	if r := second.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": recovery[0]}); r.Status != http.StatusUnauthorized || signedIn(second) {
		t.Errorf("the same recovery code again: %d %s", r.Status, r.Body)
	}
	third, r := passwordStep(a, email)
	if r := third.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": recovery[1]}); r.Status != http.StatusOK || r.JSON()["recoveryCodesLeft"] != float64(8) {
		t.Errorf("another recovery code: %d %s", r.Status, r.Body)
	}
	fourth, r := passwordStep(a, email)
	if r := fourth.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": "aaaaa-bbbbb"}); r.Status != http.StatusUnauthorized {
		t.Errorf("a recovery code nobody was given: %d", r.Status)
	}
}

func TestRecoveryCodesStillWorkIfTheKeyIsLost(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, recovery := switchedOn(t, a, cl)
	t.Setenv(auth.EncryptionKeyEnv, "") // the key is gone: the app's codes cannot be checked any more
	first, r := passwordStep(a, email)
	if r := first.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "code": codeAt(t, secret, 1)}); r.Status != http.StatusUnauthorized {
		t.Errorf("an app code without the key: %d", r.Status)
	}
	second, r := passwordStep(a, email)
	if r := second.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": recovery[0]}); r.Status != http.StatusOK {
		t.Errorf("a recovery code without the key: %d %s", r.Status, r.Body)
	}
}

func TestSwitchingOffNeedsThePasswordAndACode(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, recovery := switchedOn(t, a, cl)

	if r := cl.post("/account/two-factor/disable", map[string]string{"password": "wrong-Password-1", "code": codeAt(t, secret, 1)}); r.Status != http.StatusForbidden {
		t.Errorf("a wrong password: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/two-factor/disable", map[string]string{"password": goodPass}); r.Status != http.StatusUnauthorized {
		t.Errorf("no code: %d %s", r.Status, r.Body)
	}
	if r := cl.post("/account/two-factor/disable", map[string]string{"password": goodPass, "code": "000000"}); r.Status != http.StatusUnauthorized {
		t.Errorf("a wrong code: %d %s", r.Status, r.Body)
	}
	if !a.userByEmail(email).TwoFactorEnabled() {
		t.Fatal("switched off by a request that was refused")
	}
	if r := cl.post("/account/two-factor/disable", map[string]string{"password": goodPass, "recoveryCode": recovery[0]}); r.Status != http.StatusOK {
		t.Fatalf("switching off with a recovery code: %d %s", r.Status, r.Body)
	}
	u := a.userByEmail(email)
	if u.TwoFactorEnabled() || u.TotpSecret != "" || u.TotpLastStep != 0 {
		t.Errorf("still on: %+v", u)
	}
	if n := count(t, a.db, "SELECT count(*) FROM recovery_codes WHERE user_id = ?", u.ID); n != 0 {
		t.Errorf("%d recovery codes left behind", n)
	}
	// signing in is back to the password alone, and it can be set up again from the start
	if _, r := passwordStep(a, email); r.JSON()["user"] == nil || r.JSON()["twoFactorRequired"] == true {
		t.Errorf("after switching off: %s", r.Body)
	}
	if r := cl.post("/account/two-factor/disable", map[string]string{"password": goodPass, "code": "123456"}); r.Status != http.StatusConflict {
		t.Errorf("switching off twice: %d", r.Status)
	}
	switchedOn(t, a, cl)
}

func TestNewRecoveryCodesReplaceTheOldOnes(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	secret, old := switchedOn(t, a, cl)

	if r := cl.post("/account/two-factor/recovery-codes", map[string]string{"password": goodPass, "recoveryCode": old[0]}); r.Status != http.StatusUnauthorized {
		t.Errorf("asking with a recovery code: %d (it would be spent making the next ones)", r.Status)
	}
	if r := cl.post("/account/two-factor/recovery-codes", map[string]string{"password": goodPass, "code": "000000"}); r.Status != http.StatusUnauthorized {
		t.Errorf("asking with a wrong code: %d", r.Status)
	}
	r := cl.post("/account/two-factor/recovery-codes", map[string]string{"password": goodPass, "code": codeAt(t, secret, 1)})
	fresh, _ := r.JSON()["recoveryCodes"].([]any)
	if r.Status != http.StatusOK || len(fresh) != 10 {
		t.Fatalf("new codes: %d %s", r.Status, r.Body)
	}
	first, ch := passwordStep(a, email)
	if r := first.post("/auth/two-factor", map[string]string{"challenge": ch.Str("challenge"), "recoveryCode": old[1]}); r.Status != http.StatusUnauthorized {
		t.Errorf("an old recovery code: %d", r.Status)
	}
	second, ch := passwordStep(a, email)
	if r := second.post("/auth/two-factor", map[string]string{"challenge": ch.Str("challenge"), "recoveryCode": fresh[0].(string)}); r.Status != http.StatusOK {
		t.Errorf("a new recovery code: %d %s", r.Status, r.Body)
	}
}

func TestAnAccountWithoutAPasswordSetsUpWithoutOne(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	// the shape of an account made through Google sign-in: it never chose a password
	a.db.Model(&models.User{}).Where("email = ?", email).Updates(map[string]any{"has_password": false, "password": ""})
	if r := cl.post("/account/two-factor/setup", map[string]string{}); r.Status != http.StatusOK {
		t.Errorf("setup without a password: %d %s", r.Status, r.Body)
	}
}

func TestTheSettingsNeedASession(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	anon := a.newClient()
	for _, path := range []string{"/account/two-factor/setup", "/account/two-factor/enable", "/account/two-factor/disable", "/account/two-factor/recovery-codes"} {
		if r := anon.post(path, map[string]string{}); r.Status != http.StatusUnauthorized {
			t.Errorf("%s: %d", path, r.Status)
		}
	}
}

func TestTheSettingsCannotBeTriedOverAndOver(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, _ := a.newUser()
	cl.post("/account/two-factor/setup", map[string]string{"password": goodPass})
	limited := false
	for i := 0; i < 30 && !limited; i++ {
		limited = cl.post("/account/two-factor/enable", map[string]string{"code": "000000"}).Status == http.StatusTooManyRequests
	}
	if !limited {
		t.Error("thirty wrong codes in a row were all looked at")
	}
}

func TestDeletingAnAccountRemovesItsTwoStepData(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	switchedOn(t, a, cl)
	passwordStep(a, email) // leaves a pending challenge
	id := a.userByEmail(email).ID
	if count(t, a.db, "SELECT count(*) FROM recovery_codes WHERE user_id = ?", id) != 10 || count(t, a.db, "SELECT count(*) FROM mfa_challenges WHERE user_id = ?", id) != 1 {
		t.Fatal("expected ten recovery codes and a challenge before deleting")
	}
	if r := cl.delete("/account", map[string]string{"confirmEmail": email, "password": goodPass}); r.Status != http.StatusOK {
		t.Fatalf("delete: %d %s", r.Status, r.Body)
	}
	if count(t, a.db, "SELECT count(*) FROM recovery_codes WHERE user_id = ?", id) != 0 || count(t, a.db, "SELECT count(*) FROM mfa_challenges WHERE user_id = ?", id) != 0 {
		t.Error("two-step data was left behind")
	}
}

func TestTheDataExportSaysWhetherTwoStepIsOnButNeverHoldsASecret(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, _ := a.newUser()
	secret, recovery := switchedOn(t, a, cl)
	body := string(cl.get("/account/export").Body)
	for _, leaked := range append([]string{secret, "totp"}, recovery...) {
		if strings.Contains(strings.ToLower(body), strings.ToLower(leaked)) {
			t.Errorf("the export contains %q", leaked)
		}
	}
	if !regexp.MustCompile(`"twoFactorEnabled":\s*true`).MatchString(body) {
		t.Errorf("the export does not say that two-step is on: %.300s", body)
	}
}

func TestAnAccountsChallengesAreTidiedAsNewOnesAreMade(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	switchedOn(t, a, cl)
	for i := 0; i < 8; i++ {
		passwordStep(a, email)
	}
	if n := count(t, a.db, "SELECT count(*) FROM mfa_challenges WHERE user_id = ?", a.userByEmail(email).ID); n > 5 {
		t.Errorf("%d open challenges for one account", n)
	}
}

func TestTheAccountPageCanSeeWhetherItIsOnAndHowManyRecoveryCodesAreLeft(t *testing.T) {
	a := newApp(t)
	withTwoFactorKey(t)
	cl, email := a.newUser()
	if r := cl.get("/account/two-factor"); r.Status != http.StatusOK || r.JSON()["enabled"] != false || r.JSON()["available"] != true || r.JSON()["recoveryCodesLeft"] != nil {
		t.Errorf("before: %d %s", r.Status, r.Body)
	}
	_, recovery := switchedOn(t, a, cl)
	if r := cl.get("/account/two-factor"); r.JSON()["enabled"] != true || r.JSON()["recoveryCodesLeft"] != float64(10) {
		t.Errorf("after: %s", r.Body)
	}
	second, r := passwordStep(a, email)
	second.post("/auth/two-factor", map[string]string{"challenge": r.Str("challenge"), "recoveryCode": recovery[0]})
	if r := cl.get("/account/two-factor"); r.JSON()["recoveryCodesLeft"] != float64(9) {
		t.Errorf("after using one: %s", r.Body)
	}
	if r := a.newClient().get("/account/two-factor"); r.Status != http.StatusUnauthorized {
		t.Errorf("without a session: %d", r.Status)
	}
}
