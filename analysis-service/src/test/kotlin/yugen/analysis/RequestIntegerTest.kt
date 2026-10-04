package yugen.analysis

import com.google.gson.JsonParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RequestIntegerTest {
    @Test
    fun preservesIntegerIdentityAndRejectsCoercion() {
        listOf("2" to 2, "2.0" to 2, "2e0" to 2, "2147483647" to Int.MAX_VALUE).forEach { (json, expected) ->
            assertEquals(expected, JsonParser.parseString("""{"tokenIndex":$json}""").asJsonObject.exactInt("tokenIndex"))
        }
        listOf("2.9", "2147483648", "4294967298", "-2147483649", "\"2\"", "true", "null", "[]", "{}").forEach { json ->
            assertFailsWith<IllegalArgumentException>(json) {
                JsonParser.parseString("""{"tokenIndex":$json}""").asJsonObject.exactInt("tokenIndex")
            }
        }
        assertFailsWith<IllegalArgumentException> {
            JsonParser.parseString("{}").asJsonObject.exactInt("contractVersion")
        }
    }
}
