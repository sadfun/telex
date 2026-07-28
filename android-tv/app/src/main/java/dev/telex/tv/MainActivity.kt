package dev.telex.tv

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val preferences by lazy { getSharedPreferences("telex-tv", MODE_PRIVATE) }
    private val streamingText = mutableMapOf<String, StringBuilder>()
    private val streamingViews = mutableMapOf<String, TextView>()
    private var api: TvApiClient? = null
    private var pairingPoll: Runnable? = null
    private var currentThreadId: String? = null
    private var sessionList: LinearLayout? = null
    private var chatMessages: LinearLayout? = null
    private var chatScroll: ScrollView? = null
    private var statusView: TextView? = null
    private var messageInput: EditText? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleProvisioningIntent(intent)
        val server = preferences.getString(KEY_SERVER, null)
        val token = preferences.getString(KEY_TOKEN, null)
        if (server != null && token != null) showHome(server, token) else showSetup(server.orEmpty())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (handleProvisioningIntent(intent)) {
            showSetup(preferences.getString(KEY_SERVER, "").orEmpty())
        }
    }

    override fun onDestroy() {
        pairingPoll?.let(handler::removeCallbacks)
        api?.close()
        super.onDestroy()
    }

    private fun showSetup(initialServer: String) {
        resetTransientState()
        val root = screenColumn()
        root.gravity = Gravity.CENTER

        root.addView(
            text(
                "Telex TV",
                size = 40f,
                color = R.color.telex_primary,
                bold = true,
            ),
        )
        root.addView(
            text(
                "Connect this TV to the HTTPS address of your self-hosted Telex server.",
                size = 21f,
                color = R.color.telex_muted,
            ).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(16), 0, dp(24))
            },
        )
        val serverInput =
            EditText(this).apply {
                hint = "https://telex.example.com"
                setText(initialServer)
                setTextColor(color(R.color.telex_text))
                setHintTextColor(color(R.color.telex_muted))
                textSize = 22f
                setSingleLine(true)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                background = getDrawable(R.drawable.focusable_panel)
                layoutParams = LinearLayout.LayoutParams(dp(620), ViewGroup.LayoutParams.WRAP_CONTENT)
            }
        root.addView(serverInput)
        val connect =
            actionButton("Connect") {
                runCatching { TvApiClient.normalizeServerUrl(serverInput.text.toString()) }
                    .onSuccess(::beginPairing)
                    .onFailure { showInlineError(root, it.message ?: "Invalid server address") }
            }
        connect.layoutParams =
            LinearLayout.LayoutParams(dp(260), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                topMargin = dp(20)
            }
        root.addView(connect)
        setContentView(root)
        serverInput.requestFocus()
    }

    private fun beginPairing(serverUrl: String) {
        resetTransientState()
        preferences.edit().putString(KEY_SERVER, serverUrl).remove(KEY_TOKEN).apply()
        val client = TvApiClient(serverUrl, null)
        api = client
        val root = screenColumn()
        root.gravity = Gravity.CENTER
        val heading = text("Pair this TV", 36f, R.color.telex_text, bold = true)
        val code = text("•••• ••••", 56f, R.color.telex_primary, bold = true)
        code.typeface = Typeface.MONOSPACE
        code.setPadding(0, dp(28), 0, dp(18))
        val instructions =
            text("Requesting a one-time code…", 22f, R.color.telex_muted).apply {
                gravity = Gravity.CENTER
            }
        val error = text("", 18f, android.R.color.holo_red_light)
        error.gravity = Gravity.CENTER
        root.addView(heading)
        root.addView(code)
        root.addView(instructions)
        root.addView(error)
        root.addView(
            actionButton("Use another server") {
                showSetup(serverUrl)
            }.apply {
                layoutParams =
                    LinearLayout.LayoutParams(dp(300), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = dp(28)
                    }
            },
        )
        setContentView(root)

        client.createPairing(deviceName()) { result ->
            result
                .onSuccess { challenge ->
                    code.text = challenge.code.chunked(4).joinToString(" ")
                    instructions.text = challenge.instructions
                    schedulePairingPoll(client, challenge, error)
                }
                .onFailure { failure ->
                    error.text = failure.message ?: "Could not contact Telex"
                }
        }
    }

    private fun schedulePairingPoll(
        client: TvApiClient,
        challenge: PairingChallenge,
        errorView: TextView,
    ) {
        val poll =
            object : Runnable {
                override fun run() {
                    client.pollPairing(challenge.pairingId) { result ->
                        result
                            .onSuccess { status ->
                                when (status.getString("status")) {
                                    "pending" -> handler.postDelayed(this, challenge.pollAfterMs)
                                    "approved" -> finishPairing(client, status.toPairedDevice())
                                    "expired", "not_found" ->
                                        errorView.text =
                                            "The code expired. Go back and request a new one."
                                }
                            }
                            .onFailure { failure ->
                                errorView.text = failure.message ?: "Pairing check failed"
                                handler.postDelayed(this, 3_000)
                            }
                    }
                }
            }
        pairingPoll = poll
        handler.postDelayed(poll, challenge.pollAfterMs)
    }

    private fun finishPairing(
        client: TvApiClient,
        device: PairedDevice,
    ) {
        pairingPoll?.let(handler::removeCallbacks)
        pairingPoll = null
        client.token = device.token
        preferences
            .edit()
            .putString(KEY_TOKEN, device.token)
            .putString(KEY_DEVICE_ID, device.id)
            .apply()
        showHome(client.baseUrl, device.token)
    }

    private fun showHome(
        serverUrl: String,
        token: String,
    ) {
        resetTransientState()
        val client = TvApiClient(serverUrl, token)
        api = client
        val root = screenColumn(padding = 24)
        val header = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        header.addView(
            text("Telex TV", 28f, R.color.telex_primary, bold = true),
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        statusView = text("Connecting…", 16f, R.color.telex_muted)
        header.addView(statusView)
        header.addView(
            actionButton("Disconnect") {
                client.disconnectDevice {
                    preferences.edit().clear().apply()
                    showSetup("")
                }
            }.apply {
                textSize = 15f
                layoutParams =
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        dp(52),
                    ).apply { leftMargin = dp(18) }
            },
        )
        root.addView(header)

        val body =
            LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                weightSum = 10f
            }
        body.layoutParams =
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f).apply {
                topMargin = dp(20)
            }
        body.addView(buildSessionsPane(client), LinearLayout.LayoutParams(0, -1, 3.2f))
        body.addView(buildChatPane(client), LinearLayout.LayoutParams(0, -1, 6.8f).apply {
            leftMargin = dp(22)
        })
        root.addView(body)
        setContentView(root)

        client.connectEvents(::handleServerEvent) { state -> statusView?.text = state }
        loadSessions(client)
    }

    private fun buildSessionsPane(client: TvApiClient): View {
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(text("Tasks", 24f, R.color.telex_text, bold = true))
        column.addView(
            actionButton("+ New task") {
                currentThreadId = null
                chatMessages?.removeAllViews()
                appendMessage("assistant", "Start a new task below.")
                messageInput?.requestFocus()
            }.apply {
                layoutParams =
                    LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        topMargin = dp(12)
                        bottomMargin = dp(12)
                    }
            },
        )
        sessionList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val scroll =
            ScrollView(this).apply {
                isFillViewport = true
                addView(sessionList)
            }
        column.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        return column
    }

    private fun buildChatPane(client: TvApiClient): View {
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(text("Conversation", 24f, R.color.telex_text, bold = true))
        chatMessages =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), dp(8), dp(8))
            }
        chatScroll =
            ScrollView(this).apply {
                isFillViewport = true
                addView(chatMessages)
            }
        column.addView(chatScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        val composer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        messageInput =
            EditText(this).apply {
                hint = "Message Codex"
                setTextColor(color(R.color.telex_text))
                setHintTextColor(color(R.color.telex_muted))
                textSize = 19f
                maxLines = 4
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                background = getDrawable(R.drawable.focusable_panel)
            }
        composer.addView(messageInput, LinearLayout.LayoutParams(0, -2, 1f))
        composer.addView(
            actionButton("Send") { sendMessage(client) }.apply {
                layoutParams =
                    LinearLayout.LayoutParams(dp(150), ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        leftMargin = dp(12)
                    }
            },
        )
        column.addView(composer)
        return column
    }

    private fun loadSessions(client: TvApiClient) {
        sessionList?.removeAllViews()
        sessionList?.addView(text("Loading…", 18f, R.color.telex_muted))
        client.listSessions { result ->
            result
                .onSuccess { sessions ->
                    val list = sessionList ?: return@onSuccess
                    list.removeAllViews()
                    if (sessions.isEmpty()) {
                        list.addView(text("No Codex tasks yet.", 17f, R.color.telex_muted))
                        appendMessage("assistant", "Choose “New task” and send your first message.")
                    } else {
                        sessions.forEach { session ->
                            val button =
                                actionButton(session.title) {
                                    openSession(client, session.id)
                                }.apply {
                                    gravity = Gravity.START or Gravity.CENTER_VERTICAL
                                    maxLines = 2
                                    textSize = 17f
                                }
                            list.addView(
                                button,
                                LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT)
                                    .apply { bottomMargin = dp(8) },
                            )
                        }
                        openSession(client, sessions.first().id)
                    }
                }
                .onFailure { failure ->
                    sessionList?.removeAllViews()
                    sessionList?.addView(
                        text(failure.message ?: "Could not load tasks", 17f, android.R.color.holo_red_light),
                    )
                }
        }
    }

    private fun openSession(
        client: TvApiClient,
        threadId: String,
    ) {
        currentThreadId = threadId
        chatMessages?.removeAllViews()
        appendMessage("assistant", "Loading task…")
        client.readSession(threadId) { result ->
            result
                .onSuccess { detail ->
                    if (currentThreadId != threadId) return@onSuccess
                    chatMessages?.removeAllViews()
                    detail.messages.forEach { appendMessage(it.role, it.text) }
                    scrollChatToBottom()
                }
                .onFailure { failure ->
                    chatMessages?.removeAllViews()
                    appendMessage("error", failure.message ?: "Could not load this task")
                }
        }
    }

    private fun sendMessage(client: TvApiClient) {
        val input = messageInput ?: return
        val body = input.text.toString().trim()
        if (body.isEmpty()) return
        input.text.clear()
        appendMessage("user", body)
        client.sendMessage(body, currentThreadId) { result ->
            result.onFailure { failure ->
                appendMessage("error", failure.message ?: "Could not send message")
            }
        }
    }

    private fun handleServerEvent(event: ServerEvent) {
        when (event.type) {
            "progress" -> {
                val summary = event.payload.optString("summary")
                val message = event.payload.optString("message")
                statusView?.text =
                    listOf(summary, message).firstOrNull { it.isNotEmpty() } ?: "Working…"
            }
            "delta" -> {
                val requestId = event.requestId ?: return
                val builder = streamingText.getOrPut(requestId) { StringBuilder() }
                builder.append(event.payload.optString("delta"))
                val view =
                    streamingViews.getOrPut(requestId) {
                        appendMessage("assistant", "")
                    }
                view.text = builder.toString()
                scrollChatToBottom()
            }
            "complete" -> {
                val requestId = event.requestId
                val text = event.payload.optString("text")
                val view = requestId?.let(streamingViews::remove)
                if (view == null) appendMessage("assistant", text) else view.text = text
                if (requestId != null) streamingText.remove(requestId)
                statusView?.text = "Connected"
                loadSessions(api ?: return)
            }
            "message" -> appendMessage("assistant", event.payload.optString("text"))
            "error" -> appendMessage("error", event.payload.optString("message"))
            "notification" -> appendMessage("assistant", event.payload.optString("text"))
            "choice" -> showChoice(event.payload)
        }
    }

    private fun showChoice(payload: JSONObject) {
        val choiceId = payload.getString("choiceId")
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = getDrawable(R.drawable.focusable_panel)
        }
        wrapper.addView(text(payload.getString("prompt"), 18f, R.color.telex_text, bold = true))
        val options = payload.getJSONArray("options")
        for (index in 0 until options.length()) {
            val option = options.getJSONObject(index)
            wrapper.addView(
                actionButton(option.getString("label")) {
                    api?.answerChoice(choiceId, option.getString("id")) { result ->
                        result
                            .onSuccess {
                                wrapper.removeAllViews()
                                wrapper.addView(text("Selected: ${option.getString("label")}", 17f))
                            }
                            .onFailure { failure ->
                                appendMessage("error", failure.message ?: "Choice failed")
                            }
                    }
                }.apply {
                    layoutParams =
                        LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                            topMargin = dp(8)
                        }
                },
            )
        }
        chatMessages?.addView(
            wrapper,
            LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(12)
            },
        )
        scrollChatToBottom()
    }

    private fun appendMessage(
        role: String,
        body: String,
    ): TextView {
        val label =
            when (role) {
                "user" -> "You"
                "error" -> "Error"
                else -> "Codex"
            }
        val view =
            text(
                "$label\n$body",
                18f,
                if (role == "error") android.R.color.holo_red_light else R.color.telex_text,
            ).apply {
                background = getDrawable(R.drawable.focusable_panel)
                setPadding(dp(16), dp(12), dp(16), dp(12))
            }
        chatMessages?.addView(
            view,
            LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                bottomMargin = dp(10)
                if (role == "user") leftMargin = dp(80) else rightMargin = dp(40)
            },
        )
        scrollChatToBottom()
        return view
    }

    private fun actionButton(
        label: String,
        action: () -> Unit,
    ): Button =
        Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 18f
            setTextColor(color(R.color.telex_text))
            background = getDrawable(R.drawable.focusable_panel)
            isFocusable = true
            setOnClickListener { action() }
        }

    private fun text(
        value: String,
        size: Float = 18f,
        color: Int = R.color.telex_text,
        bold: Boolean = false,
    ): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setTextColor(color(color))
            if (bold) setTypeface(typeface, Typeface.BOLD)
        }

    private fun screenColumn(padding: Int = 48): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
            setBackgroundColor(color(R.color.telex_background))
        }

    private fun showInlineError(
        root: LinearLayout,
        message: String,
    ) {
        val existing = root.findViewWithTag<TextView>("inline-error")
        if (existing != null) existing.text = message
        else {
            root.addView(
                text(message, 17f, android.R.color.holo_red_light).apply {
                    tag = "inline-error"
                    gravity = Gravity.CENTER
                    setPadding(0, dp(16), 0, 0)
                },
            )
        }
    }

    private fun scrollChatToBottom() {
        chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun resetTransientState() {
        pairingPoll?.let(handler::removeCallbacks)
        pairingPoll = null
        api?.close()
        api = null
        currentThreadId = null
        sessionList = null
        chatMessages = null
        chatScroll = null
        statusView = null
        messageInput = null
        streamingText.clear()
        streamingViews.clear()
    }

    private fun handleProvisioningIntent(intent: Intent?): Boolean {
        val data: Uri = intent?.data ?: return false
        if (data.scheme != "telex" || data.host != "connect") return false
        val server = data.getQueryParameter("server") ?: return false
        val normalized = runCatching { TvApiClient.normalizeServerUrl(server) }.getOrNull() ?: return false
        preferences.edit().putString(KEY_SERVER, normalized).remove(KEY_TOKEN).apply()
        return true
    }

    private fun deviceName(): String {
        val model = android.os.Build.MODEL?.trim().orEmpty()
        if (model.isNotEmpty()) return "TV — $model"
        val id = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        return "Android TV ${id.takeLast(4)}"
    }

    @Suppress("DEPRECATION")
    private fun color(resource: Int): Int = resources.getColor(resource)

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_SERVER = "server"
        private const val KEY_TOKEN = "token"
        private const val KEY_DEVICE_ID = "device-id"
    }
}
