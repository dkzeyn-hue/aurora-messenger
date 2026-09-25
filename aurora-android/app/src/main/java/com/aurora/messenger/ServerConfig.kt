package com.aurora.messenger

/**
 * DEFAULT Aurora server address — used to prefill the first-launch "Connect" screen.
 *
 * The address is editable in the app itself (shown on first launch, and via
 * "Change server" in the connection-error dialog), so you can point Aurora at
 * any host without rebuilding:
 *
 *  • Your own one-click deployment (see the repo README on GitHub)
 *  • Android emulator:      http://10.0.2.2:3000   (your computer, via `npm start`)
 *  • Real phone on Wi-Fi:    http://<your-computer-IP>:3000
 *  • Your own deployment:    https://your-aurora-server.example.com
 */
object ServerConfig {
    const val DEFAULT_SERVER_URL = "https://your-aurora-server.example.com"
}
