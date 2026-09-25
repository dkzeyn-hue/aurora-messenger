# 🌌 Aurora Messenger — Android Studio Project

Native Android app (Kotlin) that wraps the Aurora web messenger in a WebView.
The **UI is the exact same HTML5 app** — the Android shell adds the native glue a browser
gets for free: file picker for photo/media uploads, microphone permission for voice
messages, back-button navigation, session persistence, and external links opening in
the system browser.

## 🌍 Hosted instance (running in my sandbox)

**https://groundwater-logging-fragrance-passion.trycloudflare.com**

A public HTTPS host I run for you via a Cloudflare tunnel. The APK below comes
**preconfigured to it** — install the APK, open it, chat. No PC needed.

Because the address can change when the tunnel restarts, the app lets you **edit the
server address at runtime**: first launch shows a "Connect to Aurora" screen, and the
"Can't reach Aurora" dialog has a **Change server** button. No rebuild ever needed.

> ⚠️ Honest limits of my host: it lives inside our session sandbox — it's awake while
> we're working together and sleeps between visits (message me and I'll wake it up).
> Your accounts & messages persist in the workspace database. For a permanent 24/7
> host you'd deploy `aurora/` to Render/Railway/Fly/a VPS with your own account —
> happy to prepare that whole package.

```
aurora-android/
├── app/src/main/java/com/aurora/messenger/
│   ├── MainActivity.kt    ← the WebView shell (server picker, file chooser, mic, back button)
│   └── ServerConfig.kt    ← default server address (prefills the Connect screen)
├── app/src/main/AndroidManifest.xml
├── app/src/main/res/      ← adaptive launcher icon (Aurora "A" on purple gradient), theme
├── apk/Aurora-debug.apk   ← ready-to-install debug APK (preconfigured to the hosted instance)
└── gradle wrapper + standard Gradle Kotlin DSL build files
```

## ⚡ Quick start

**Option A — use my hosted instance (easiest):** install `apk/Aurora-debug.apk` on your
phone, open it, press **Connect**. Done.

**Option B — run your own server on your computer:**
1. **Open in Android Studio** — File → Open → select the `aurora-android` folder.
   Let Gradle sync (it downloads dependencies on first sync).
2. **Start the Aurora server on your computer:**
   ```bash
   cd aurora
   npm install
   npm start          # → Aurora server listening on http://0.0.0.0:3000
   ```
3. **Run the app** ▶ — on an emulator enter `http://10.0.2.2:3000` on the Connect screen
   (the emulator's alias for your computer).

### Real phone instead of emulator?
Enter your computer's Wi-Fi IP on the app's Connect screen: `http://192.168.1.20:3000`
(find it with `ipconfig` on Windows, `ip a` on Linux, `ifconfig` on macOS).
Phone and computer must be on the same Wi-Fi.

### No Android Studio? Install the prebuilt APK directly
Copy `apk/Aurora-debug.apk` to your phone, open it, and allow "install from unknown
sources".

## 🔧 Building the APK yourself

```bash
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Release build (for sharing / Play Store):
```bash
./gradlew assembleRelease     # unsigned; sign via Android Studio → Generate Signed Bundle/APK
```

## ✅ What works in the Android app

| Feature | Status |
|---|---|
| Register / login (username + password) | ✅ |
| All chats, groups, channels, stories, media | ✅ |
| **Profile photo upload** — uses the native Android photo picker | ✅ |
| Receiving & playing voice messages | ✅ |
| Recording voice messages | ✅ over the HTTPS host (secure context); over plain http it needs an HTTPS proxy |
| Session persistence across app restarts | ✅ (localStorage + WebView state) |
| Back button walks app history, then exits | ✅ |
| Server unreachable | ✅ native "Can't reach Aurora" dialog with Retry / Change server |
| Push notifications in the background | ❌ (needs Firebase setup — ask if you want it) |

## 📱 App details

- **Package:** `com.aurora.messenger` · **minSdk 26** (Android 8.0+, ~97% of devices) · **targetSdk 34**
- **Stack:** Kotlin, AndroidX (appcompat), WebView — no other frameworks, matching the project's vanilla approach
- `android:usesCleartextTraffic="true"` is set so the app can talk to **local dev servers over http://**.
  Remove that line from `AndroidManifest.xml` for a production build behind HTTPS.

## 🗂 Related folders in this workspace

- `aurora/` — the Aurora server + web app (unchanged; the Android app connects to it)
- `aurora-android/apk/Aurora-debug.apk` — the built debug APK

