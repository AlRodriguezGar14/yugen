package yugen.analysis

import com.google.gson.JsonParser
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class OpenAiSentenceTranslatorTest {
    @Test
    fun disabledAiRejectsEvenWithAKeyBeforeNetworkAccessAndNanoUsesMinimalReasoning() {
        assertFailsWith<TranslationNotConfiguredException> {
            OpenAiSentenceTranslator(apiKey = "unused-test-key", enabled = false)
                .translate("米", "ja", "en", emptyList())
        }
        val request = createOpenAiTranslationRequest("米", "ja", "en", emptyList(), "gpt-5-nano")
        assertEquals("minimal", request.getAsJsonObject("reasoning").get("effort").asString)
    }

    @Test
    fun requestsSentenceFirstThenContextualWordMeaningsWithoutProviderStorage() {
        val words = listOf(TranslationWord(tokenIndex = 0, surface = "金芽米"))
        val request = createOpenAiTranslationRequest("金芽米使用", "ja", "en", words, "test-model")

        assertEquals("test-model", request.get("model").asString)
        val input = JsonParser.parseString(request.get("input").asString).asJsonObject
        assertEquals("金芽米使用", input.get("sentence").asString)
        assertEquals("金芽米", input.getAsJsonArray("words").first().asJsonObject.get("surface").asString)
        assertFalse(request.get("store").asBoolean)
        assertEquals("json_schema", request.getAsJsonObject("text").getAsJsonObject("format").get("type").asString)
        assertTrue(request.getAsJsonObject("text").getAsJsonObject("format").get("strict").asBoolean)
        assertTrue(request.getAsJsonObject("text").getAsJsonObject("format").getAsJsonObject("schema").getAsJsonObject("properties").has("wordMeanings"))
        assertTrue(request.get("instructions").asString.contains("Translate the entire text"))
        assertTrue(request.get("instructions").asString.contains("one contextual sentence or sign"))
        assertTrue(request.get("instructions").asString.contains("Then give one concise"))
        assertTrue(request.get("instructions").asString.contains("using the full sentence as context"))
    }

    @Test
    fun extractsSentenceAndMatchingContextualWordMeaningsFromCompletedOutput() {
        val words = listOf(TranslationWord(tokenIndex = 2, surface = "米"))
        val body = """
            {"status":"completed","output":[
              {"type":"reasoning","id":"r1"},
              {"type":"message","content":[{"type":"output_text","text":"{\"translation\":\"Uses Kinmemai rice.\",\"wordMeanings\":[{\"tokenIndex\":2,\"surface\":\"米\",\"text\":\"rice\"}]}"}]}
            ]}
        """.trimIndent()

        val result = extractTranslation(body, words)
        assertEquals("Uses Kinmemai rice.", result.translation)
        assertEquals(listOf(ContextualWordMeaning(2, "米", "rice")), result.wordMeanings)
        assertFailsWith<IllegalStateException> {
            extractTranslation("""{"status":"incomplete","output":[]}""", words)
        }
        val mismatched = body.replace("\\\"surface\\\":\\\"米\\\"", "\\\"surface\\\":\\\"米国\\\"")
        assertFailsWith<IllegalStateException> {
            extractTranslation(mismatched, words)
        }
    }

    @Test
    fun missingProviderKeyFailsBeforeAnyNetworkRequest() {
        val translator = OpenAiSentenceTranslator(apiKey = null)

        assertFailsWith<TranslationNotConfiguredException> {
            translator.translate("金芽米使用", "ja", "en", emptyList())
        }
    }

    @Test
    fun rejectsCoercedProviderWordIdentity() {
        val words = listOf(TranslationWord(tokenIndex = 2, surface = "米"))
        listOf("2.9", "4294967298", "\"2\"").forEach { index ->
            val output = """{"translation":"Rice.","wordMeanings":[{"tokenIndex":$index,"surface":"米","text":"rice"}]}"""
            val response = com.google.gson.JsonObject().apply {
                addProperty("status", "completed")
                addProperty("output_text", output)
            }
            assertFailsWith<IllegalArgumentException> {
                extractTranslation(response.toString(), words)
            }
        }
    }
}
