package dev.telex.tv

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class TvApiClient(
    serverUrl: String,
    token: String?,
) {
    val baseUrl: String = normalizeServerUrl(serverUrl)

    @Volatile
    var token: String? = token

    private val executor = Executors.newCachedThreadPool()
    private val main = Handler(Looper.getMainLooper())
    private val eventsRunning = AtomicBoolean(false)

    fun createPairing(
        deviceName: String,
        callback: (Result<PairingChallenge>) -> Unit,
    ) {
        jsonRequest(
            method = "POST",
            path = "/api/tv/pairings",
            body =
                JSONObject()
                    .put("deviceName", deviceName)
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("platformVersion", "Android ${android.os.Build.VERSION.RELEASE}"),
            authenticated = false,
        ) { result -> callback(result.map { it.toPairingChallenge() }) }
    }

    fun pollPairing(
        pairingId: String,
        callback: (Result<JSONObject>) -> Unit,
    ) {
        jsonRequest(
            method = "GET",
            path = "/api/tv/pairings/${encodePath(pairingId)}",
            authenticated = false,
            callback = callback,
        )
    }

    fun listSessions(callback: (Result<List<SessionSummary>>) -> Unit) {
        jsonRequest("GET", "/api/tv/sessions") { result ->
            callback(result.map { it.getJSONArray("sessions").sessionSummaries() })
        }
    }

    fun readSession(
        threadId: String,
        callback: (Result<SessionDetail>) -> Unit,
    ) {
        jsonRequest("GET", "/api/tv/sessions/${encodePath(threadId)}") { result ->
            callback(result.map { it.toSessionDetail() })
        }
    }

    fun sendMessage(
        text: String,
        threadId: String?,
        callback: (Result<String>) -> Unit,
    ) {
        val body = JSONObject().put("text", text)
        if (threadId != null) body.put("threadId", threadId)
        jsonRequest("POST", "/api/tv/messages", body) { result ->
            callback(result.map { it.getString("requestId") })
        }
    }

    fun answerChoice(
        choiceId: String,
        optionId: String,
        callback: (Result<Unit>) -> Unit,
    ) {
        jsonRequest(
            "POST",
            "/api/tv/choices/${encodePath(choiceId)}",
            JSONObject().put("optionId", optionId),
        ) { result -> callback(result.map { Unit }) }
    }

    fun disconnectDevice(callback: (Result<Unit>) -> Unit) {
        jsonRequest("DELETE", "/api/tv/device") { result -> callback(result.map { Unit }) }
    }

    fun connectEvents(
        onEvent: (ServerEvent) -> Unit,
        onState: (String) -> Unit,
    ) {
        if (!eventsRunning.compareAndSet(false, true)) return
        executor.execute {
            var lastEventId = 0L
            var retryMs = 1_000L
            while (eventsRunning.get()) {
                try {
                    main.post { onState("Connected") }
                    lastEventId = readEvents(lastEventId, onEvent)
                    retryMs = 1_000L
                } catch (error: Exception) {
                    if (!eventsRunning.get()) break
                    main.post { onState("Reconnecting…") }
                    Thread.sleep(retryMs)
                    retryMs = (retryMs * 2).coerceAtMost(10_000L)
                }
            }
        }
    }

    fun close() {
        eventsRunning.set(false)
        executor.shutdownNow()
    }

    private fun jsonRequest(
        method: String,
        path: String,
        body: JSONObject? = null,
        authenticated: Boolean = true,
        callback: (Result<JSONObject>) -> Unit,
    ) {
        executor.execute {
            val result =
                runCatching {
                    val connection = open(path, method, authenticated)
                    try {
                        if (body != null) {
                            connection.setRequestProperty("Content-Type", "application/json")
                            connection.doOutput = true
                            connection.outputStream.bufferedWriter(Charsets.UTF_8).use { writer ->
                                writer.write(body.toString())
                            }
                        }
                        readJsonResponse(connection)
                    } finally {
                        connection.disconnect()
                    }
                }
            main.post { callback(result) }
        }
    }

    private fun readEvents(
        lastKnownEventId: Long,
        onEvent: (ServerEvent) -> Unit,
    ): Long {
        val connection = open("/api/tv/events", "GET", authenticated = true)
        connection.readTimeout = 45_000
        connection.setRequestProperty("Accept", "text/event-stream")
        if (lastKnownEventId > 0) {
            connection.setRequestProperty("Last-Event-ID", lastKnownEventId.toString())
        }
        if (connection.responseCode !in 200..299) {
            val message = connection.errorStream?.bufferedReader()?.use(BufferedReader::readText)
            connection.disconnect()
            throw IOException("Event stream failed (${connection.responseCode}): $message")
        }
        var lastEventId = lastKnownEventId
        connection.inputStream.bufferedReader().use { reader ->
            var data: String? = null
            while (eventsRunning.get()) {
                val line = reader.readLine() ?: break
                when {
                    line.startsWith("id:") ->
                        lastEventId = line.substringAfter(":").trim().toLongOrNull() ?: lastEventId
                    line.startsWith("data:") ->
                        data = line.substringAfter(":").trim()
                    line.isEmpty() && data != null -> {
                        val event = JSONObject(data).toServerEvent()
                        main.post { onEvent(event) }
                        data = null
                    }
                }
            }
        }
        connection.disconnect()
        return lastEventId
    }

    private fun open(
        path: String,
        method: String,
        authenticated: Boolean,
    ): HttpURLConnection {
        val connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 10_000
        connection.readTimeout = 30_000
        connection.instanceFollowRedirects = false
        connection.setRequestProperty("Accept", "application/json")
        if (authenticated) {
            val currentToken = token ?: throw IOException("This TV is not paired")
            connection.setRequestProperty("Authorization", "Bearer $currentToken")
        }
        return connection
    }

    private fun readJsonResponse(connection: HttpURLConnection): JSONObject {
        val status = connection.responseCode
        val stream =
            if (status in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        if (status !in 200..299) {
            val detail =
                runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
            throw IOException("Telex returned $status${if (detail.isEmpty()) "" else ": $detail"}")
        }
        return if (text.isEmpty()) JSONObject() else JSONObject(text)
    }

    companion object {
        fun normalizeServerUrl(value: String): String {
            val trimmed = value.trim().trimEnd('/')
            val uri =
                runCatching { URI(trimmed) }.getOrElse {
                    throw IllegalArgumentException("Enter a valid Telex server URL")
                }
            val protocolAllowed =
                uri.scheme == "https" || (BuildConfig.DEBUG && uri.scheme == "http")
            require(protocolAllowed) {
                if (BuildConfig.DEBUG) "Use an http(s) URL" else "The Telex server must use HTTPS"
            }
            require(
                uri.host != null &&
                    uri.userInfo == null &&
                    uri.query == null &&
                    uri.fragment == null &&
                    (uri.path.isNullOrEmpty() || uri.path == "/"),
            ) {
                "Use only the Telex origin, for example https://telex.example.com"
            }
            return trimmed
        }

        private fun encodePath(value: String): String =
            java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
    }
}
