package dev.telex.tv

import org.json.JSONArray
import org.json.JSONObject

data class PairingChallenge(
    val pairingId: String,
    val code: String,
    val expiresAt: String,
    val pollAfterMs: Long,
    val instructions: String,
)

data class PairedDevice(
    val id: String,
    val name: String,
    val token: String,
)

data class SessionSummary(
    val id: String,
    val title: String,
    val preview: String,
    val updatedAt: String,
    val status: String,
)

data class ChatMessage(
    val id: String,
    val role: String,
    val text: String,
    val timestamp: String?,
)

data class SessionDetail(
    val session: SessionSummary,
    val messages: List<ChatMessage>,
)

data class ServerEvent(
    val id: Long,
    val type: String,
    val requestId: String?,
    val payload: JSONObject,
)

fun JSONObject.toPairingChallenge(): PairingChallenge =
    PairingChallenge(
        pairingId = getString("pairingId"),
        code = getString("code"),
        expiresAt = getString("expiresAt"),
        pollAfterMs = optLong("pollAfterMs", 1_500),
        instructions = getString("instructions"),
    )

fun JSONObject.toPairedDevice(): PairedDevice {
    val device = getJSONObject("device")
    return PairedDevice(
        id = device.getString("id"),
        name = device.getString("name"),
        token = getString("token"),
    )
}

fun JSONObject.toSessionSummary(): SessionSummary =
    SessionSummary(
        id = getString("id"),
        title = getString("title"),
        preview = optString("preview"),
        updatedAt = getString("updatedAt"),
        status = getString("status"),
    )

fun JSONObject.toSessionDetail(): SessionDetail {
    val messagesJson = getJSONArray("messages")
    return SessionDetail(
        session = getJSONObject("session").toSessionSummary(),
        messages =
            messagesJson.mapObjects { message ->
                ChatMessage(
                    id = message.getString("id"),
                    role = message.getString("role"),
                    text = message.getString("text"),
                    timestamp =
                        if (message.isNull("timestamp")) null else message.getString("timestamp"),
                )
            },
    )
}

fun JSONObject.toServerEvent(): ServerEvent =
    ServerEvent(
        id = getLong("id"),
        type = getString("type"),
        requestId = if (isNull("requestId")) null else optString("requestId").ifEmpty { null },
        payload = getJSONObject("payload"),
    )

fun JSONArray.sessionSummaries(): List<SessionSummary> =
    mapObjects { item -> item.toSessionSummary() }

private fun <T> JSONArray.mapObjects(transform: (JSONObject) -> T): List<T> =
    buildList(length()) {
        for (index in 0 until length()) add(transform(getJSONObject(index)))
    }
