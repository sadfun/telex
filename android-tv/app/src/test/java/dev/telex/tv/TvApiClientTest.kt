package dev.telex.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class TvApiClientTest {
    @Test
    fun normalizesAnHttpsOrigin() {
        assertEquals(
            "https://telex.example.com",
            TvApiClient.normalizeServerUrl(" https://telex.example.com/ "),
        )
    }

    @Test
    fun permitsHttpForTheDebugBuild() {
        assertEquals(
            "http://10.0.2.2:8787",
            TvApiClient.normalizeServerUrl("http://10.0.2.2:8787"),
        )
    }

    @Test
    fun rejectsCredentialsAndApplicationPaths() {
        assertThrows(IllegalArgumentException::class.java) {
            TvApiClient.normalizeServerUrl("https://user@example.com")
        }
        assertThrows(IllegalArgumentException::class.java) {
            TvApiClient.normalizeServerUrl("https://telex.example.com/miniapp")
        }
    }
}
