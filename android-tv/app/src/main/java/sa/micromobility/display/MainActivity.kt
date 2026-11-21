package sa.micromobility.display

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView

class MainActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var root: FrameLayout
    private lateinit var message: TextView
    private lateinit var webView: WebView

    /** True once the current main-frame load has failed, until the next attempt starts. */
    private var loadFailed = false

    private var backMenuShown = false
    private val menuPresses = ArrayDeque<Long>()

    private val retry = Runnable { loadDisplay() }
    private val periodicReload = object : Runnable {
        override fun run() {
            loadDisplay()
            handler.postDelayed(this, RELOAD_EVERY_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        message = TextView(this).apply {
            text = "Reconnecting…"
            setTextColor(Color.WHITE)
            textSize = 32f
            gravity = Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        webView = createWebView()
        root.addView(webView, matchParent())
        root.addView(message, matchParent())
        setContentView(root)

        hideSystemBars()
        loadDisplay()
        handler.postDelayed(periodicReload, RELOAD_EVERY_MS)
    }

    override fun onResume() {
        super.onResume()
        hideSystemBars()
        webView.onResume()
    }

    override fun onPause() {
        // Make sure cookies reach disk before a power cut.
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
        super.onDestroy()
    }

    private fun matchParent() = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
    )

    @Suppress("DEPRECATION")
    private fun hideSystemBars() {
        // The old flags still work on every API level and are enough for a TV.
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN
            or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(Color.BLACK)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
        }
        view.webViewClient = DisplayClient()
        return view
    }

    private fun loadDisplay() {
        handler.removeCallbacks(retry)
        loadFailed = false
        webView.loadUrl(BuildConfig.DISPLAY_URL)
    }

    private fun showReconnecting() {
        loadFailed = true
        message.visibility = View.VISIBLE
        handler.removeCallbacks(retry)
        handler.postDelayed(retry, RETRY_MS)
    }

    private fun recreateWebView() {
        root.removeView(webView)
        webView.destroy()
        webView = createWebView()
        root.addView(webView, 0, matchParent())
    }

    private inner class DisplayClient : WebViewClient() {

        // Stay inside the WebView, and only ever go to https pages.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            !isHttps(request.url)

        @Deprecated("Needed below API 24")
        override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean =
            !isHttps(Uri.parse(url))

        override fun onPageFinished(view: WebView, url: String?) {
            if (!loadFailed) message.visibility = View.GONE
        }

        @TargetApi(Build.VERSION_CODES.M)
        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame) showReconnecting()
        }

        // Below API 23 this is only called for the main frame.
        @Deprecated("Needed below API 23")
        override fun onReceivedError(view: WebView, errorCode: Int, description: String?, failingUrl: String?) {
            showReconnecting()
        }

        @TargetApi(Build.VERSION_CODES.M)
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (request.isForMainFrame) showReconnecting()
        }

        // Returning true keeps the app alive when the page's renderer crashes or is killed for memory.
        @TargetApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                recreateWebView()
                showReconnecting()
            }
            return true
        }
    }

    private fun isHttps(uri: Uri?) = uri?.scheme.equals("https", ignoreCase = true)

    // Remote control: Back does nothing; a long Back or five quick Menu presses open the menu.
    // Handled here, before the WebView sees the key, so the page can't swallow it.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                val heldMs = event.eventTime - event.downTime
                when (event.action) {
                    KeyEvent.ACTION_DOWN ->
                        if (event.repeatCount == 0) {
                            backMenuShown = false
                        } else if (!backMenuShown && (event.isLongPress || heldMs >= LONG_PRESS_MS)) {
                            backMenuShown = true
                            showMenu(openedByBackDownTime = event.downTime)
                        }
                    // Some remotes send no key repeats, so also check how long it was held on release.
                    KeyEvent.ACTION_UP ->
                        if (!backMenuShown && heldMs >= LONG_PRESS_MS) {
                            backMenuShown = true
                            showMenu()
                        }
                }
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP) {
                    val now = event.eventTime
                    menuPresses.addLast(now)
                    while (menuPresses.isNotEmpty() && now - menuPresses.first() > MENU_WINDOW_MS) {
                        menuPresses.removeFirst()
                    }
                    if (menuPresses.size >= 5) {
                        menuPresses.clear()
                        showMenu()
                    }
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    private fun showMenu(openedByBackDownTime: Long = -1L) {
        if (isFinishing) return
        val items = arrayOf("Reload", "Clear pairing and reload", "Close app")
        AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(getString(R.string.app_name))
            .setItems(items) { _, which ->
                when (which) {
                    0 -> loadDisplay()
                    1 -> clearPairing()
                    2 -> finishAndRemoveTask()
                }
            }
            // The rest of the long Back press that opened the menu must not close it again.
            .setOnKeyListener { _, keyCode, event ->
                keyCode == KeyEvent.KEYCODE_BACK && event.downTime == openedByBackDownTime
            }
            .show()
    }

    private fun clearPairing() {
        // Clear the open page's storage first, so it can't write its key back while unloading.
        webView.evaluateJavascript("try{localStorage.clear();sessionStorage.clear()}catch(e){}") {
            WebStorage.getInstance().deleteAllData()
            webView.clearCache(true)
            CookieManager.getInstance().removeAllCookies {
                CookieManager.getInstance().flush()
                loadDisplay()
            }
        }
    }

    private companion object {
        const val RETRY_MS = 10_000L
        const val RELOAD_EVERY_MS = 6 * 60 * 60 * 1000L
        const val LONG_PRESS_MS = 800L
        const val MENU_WINDOW_MS = 3_000L
    }
}
