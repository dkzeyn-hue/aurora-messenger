package com.aurora.messenger

import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.inputmethod.EditorInfo
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * Aurora — native Android shell around the Aurora web messenger.
 *
 * The whole UI is the existing HTML5 app running in a WebView; this activity adds
 * the native glue that a plain WebView lacks:
 *  • server auto-discovery → fetches the current live server address from the project's
 *    GitHub Pages site at startup, so the app keeps working even when the server moves.
 *    A manual address (Connect dialog) always overrides discovery.
 *  • file chooser    → profile photo upload & media sharing (<input type="file">)
 *  • mic permission  → recording voice messages
 *  • back button     → walks the app's history like the browser does
 *  • state restore   → keeps you logged in when the app goes to the background
 *  • external links  → open in the system browser instead of hijacking the shell
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "Aurora"
        private const val PREFS = "aurora"
        private const val KEY_SERVER = "server_url"
        private const val KEY_MANUAL = "manual_server"

        /**
         * Fixed public pointers to the live Aurora server (hosted with this project on
         * GitHub, so they are always reachable). The app reads `server-discovery.json`
         * at startup and connects to whatever address it contains — moving the backend
         * then only requires updating that file, not the app.
         */
        private val DISCOVERY_URLS = arrayOf(
            "https://dkzeyn-hue.github.io/aurora-messenger/server-discovery.json",
            "https://raw.githubusercontent.com/dkzeyn-hue/aurora-messenger/main/server-discovery.json"
        )
    }

    private lateinit var web: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null
    private var errorDialog: AlertDialog? = null
    private var serverDialog: AlertDialog? = null

    /** Where the Aurora server lives — editable at runtime, persisted in SharedPreferences. */
    private fun serverUrl(): String =
        getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null)
            ?: ServerConfig.DEFAULT_SERVER_URL

    private fun saveServerUrl(url: String) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply()
    }

    /** True when the user picked the address by hand — manual choice always wins. */
    private fun isManualServer(): Boolean =
        getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_MANUAL, false)

    private fun setManualServer(v: Boolean) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_MANUAL, v).apply()
    }

    /** Result of the native file picker (avatar upload, media sharing). */
    private val fileChooserLauncher: ActivityResultLauncher<Intent> =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val cb = filePathCallback ?: return@registerForActivityResult
            filePathCallback = null
            val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
            cb.onReceiveValue(uris ?: arrayOf())
        }

    /** Result of the native microphone permission (voice messages). */
    private val micPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            val req = pendingWebPermission ?: return@registerForActivityResult
            pendingWebPermission = null
            if (granted) req.grant(req.resources) else req.deny()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        setupWebView()

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState)
            if (web.url.isNullOrEmpty()) resolveServerAndLoad()
        } else {
            resolveServerAndLoad()
        }
    }

    /** Decide which server to load: the user's manual choice, or the auto-discovered address. */
    private fun resolveServerAndLoad() {
        if (isManualServer()) {
            web.loadUrl(serverUrl())
            return
        }
        Thread {
            val discovered = discoverServer()
            runOnUiThread {
                if (discovered != null) {
                    if (discovered != serverUrl()) saveServerUrl(discovered)
                    web.loadUrl(discovered)
                } else {
                    // discovery unreachable — fall back to the last known address
                    web.loadUrl(serverUrl())
                }
            }
        }.start()
    }

    /** Fetch the current server address from the public discovery pointers. */
    private fun discoverServer(): String? {
        for (base in DISCOVERY_URLS) {
            try {
                val conn = java.net.URI.create(base).toURL().openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 4000
                conn.readTimeout = 4000
                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().use { it.readText() }
                    val m = Regex("\"server\"\\s*:\\s*\"(https?://[^\"]+)\"").find(body)
                    if (m != null) return m.groupValues[1]
                }
            } catch (e: Exception) {
                Log.w(TAG, "discovery failed for $base: ${e.message}")
            }
        }
        return null
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true                 // localStorage: sessions, caches
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false // voice messages auto-play
            allowFileAccess = true
            allowContentAccess = true                // content:// uris from the file picker
            userAgentString = "$userAgentString AuroraAndroid/1.0"
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url
                val server = Uri.parse(serverUrl())
                val isAppHost = target.host == server.host && target.port == server.port
                return if (isAppHost) {
                    false // Aurora itself stays inside the shell
                } else {
                    // anything else (external sites) → system browser
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, target))
                    } catch (_: Exception) {
                    }
                    true
                }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                // only react to main-frame failures (server down / no network), not sub-resources
                if (request.isForMainFrame) showErrorDialog()
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null) // resolve any stale picker first
                filePathCallback = callback
                return try {
                    fileChooserLauncher.launch(params.createIntent())
                    true
                } catch (e: Exception) {
                    Log.e(TAG, "file chooser failed", e)
                    filePathCallback = null
                    false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        if (ContextCompat.checkSelfPermission(
                                this@MainActivity, android.Manifest.permission.RECORD_AUDIO
                            ) == PackageManager.PERMISSION_GRANTED
                        ) {
                            request.grant(request.resources)
                        } else {
                            pendingWebPermission = request
                            micPermissionLauncher.launch(android.Manifest.permission.RECORD_AUDIO)
                        }
                    } else {
                        request.deny()
                    }
                }
            }

            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                if (msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                    Log.e(TAG, "[web] ${msg.message()} (${msg.sourceId()}:${msg.lineNumber()})")
                }
                return true
            }
        }
    }

    /** Manual server override: which Aurora server should the app connect to? */
    private fun showServerDialog(prefill: String = serverUrl()) {
        if (serverDialog?.isShowing == true) return
        val input = EditText(this).apply {
            setText(prefill)
            hint = "https://your-aurora-server"
            imeOptions = EditorInfo.IME_ACTION_GO
            setSingleLine()
        }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(TextView(this@MainActivity).apply {
                text = "Aurora connects to a server. Enter its address:"
                textSize = 14f
                setPadding(0, 0, 0, pad / 2)
            })
            addView(input)
        }
        fun connect() {
            var url = input.text.toString().trim()
            if (url.isEmpty()) return
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
            saveServerUrl(url)
            setManualServer(true)
            serverDialog?.dismiss()
            errorDialog?.dismiss()
            web.clearCache(true)
            web.loadUrl(url)
            Toast.makeText(this, "Connecting to $url", Toast.LENGTH_SHORT).show()
        }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) { connect(); true } else false
        }
        serverDialog = AlertDialog.Builder(this)
            .setTitle("Connect to Aurora")
            .setView(content)
            .setPositiveButton("Connect") { _, _ -> connect() }
            .setNeutralButton("Auto (default)") { _, _ ->
                setManualServer(false)
                errorDialog?.dismiss()
                web.loadUrl(serverUrl())
                resolveServerAndLoad()
            }
            .setCancelable(false)
            .show()
    }

    private fun showErrorDialog() {
        if (errorDialog?.isShowing == true) return
        errorDialog = AlertDialog.Builder(this)
            .setTitle("Can't reach Aurora")
            .setMessage(
                "The Aurora server is not reachable at\n\n${serverUrl()}\n\n" +
                    "Check your internet connection, switch to auto-discovery, or enter a different server."
            )
            .setPositiveButton("Retry") { _, _ -> resolveServerAndLoad() }
            .setNeutralButton("Change server") { _, _ -> showServerDialog() }
            .setNegativeButton("Exit") { _, _ -> finish() }
            .setCancelable(false)
            .show()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }
}
