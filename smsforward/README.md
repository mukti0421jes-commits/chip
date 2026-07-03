# OTP Reader (local-only)

A small Android app that shows incoming SMS **on this phone** and highlights the
OTP code so you can read it quickly and type it in yourself. It is deliberately
**local only**:

- No `INTERNET` permission — the app literally cannot send anything anywhere.
- No forwarding to a server, no webhook, no auto-login, no OCR upload.
- Received messages are kept in local `SharedPreferences` only, and you can
  clear them any time with the **Clear** button.

It reads the incoming SMS text, finds the first standalone 4–8 digit number,
and shows it in a large green badge (tap it to copy to the clipboard). You
still enter the code manually.

## Build the APK

You have Android Studio installed, so:

1. **File → Open** and select this `smsforward/` folder.
2. Let Gradle sync (Android Studio will fetch the Gradle wrapper and the
   Android SDK components it needs).
3. **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. The debug APK appears at `app/build/outputs/apk/debug/app-debug.apk`.
   Use the "locate" link in the build popup, then copy it to your phone and
   install (enable "Install unknown apps" for your file manager).

Command line alternative (from this folder), once the SDK path is set in
`local.properties`:

```
./gradlew assembleDebug
```

## Permissions

On first launch the app asks for **Receive SMS** / **Read SMS**. Grant them so
it can display incoming codes. That is the only permission it uses.

## Project layout

```
app/src/main/
  AndroidManifest.xml        # RECEIVE_SMS + READ_SMS only, no INTERNET
  java/com/example/smsforward/
    MainActivity.kt          # shows the list, asks for permission
    SmsReceiver.kt           # catches incoming SMS, stores locally
    SmsStore.kt              # local storage + OTP digit extraction
    SmsAdapter.kt            # list row rendering + copy-to-clipboard
  res/layout/                # dark UI, green OTP badge
```
