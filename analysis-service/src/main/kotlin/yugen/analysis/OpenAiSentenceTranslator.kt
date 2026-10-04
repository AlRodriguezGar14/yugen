package yugen.analysis

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

internal data class TranslationWord(val tokenIndex: Int, val surface: String)

internal data class ContextualWordMeaning(val tokenIndex: Int, val surface: String, val text: String)

internal data class SentenceTranslationResult(
    val translation: String,
    val wordMeanings: List<ContextualWordMeaning>,
)

internal class TranslationNotConfiguredException : RuntimeException()

internal class OpenAiSentenceTranslator(
    private val apiKey: String? = System.getenv("OPENAI_API_KEY"),
    private val provider: String = System.getenv("AI_PROVIDER") ?: "openai",
    private val model: String = System.getenv("AI_MODEL")?.trim()?.takeIf(String::isNotEmpty) ?: "gpt-5-nano",
    private val enabled: Boolean = System.getenv("YUGEN_AI_ENABLED") == "true",
    private val client: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build(),
) {
    fun translate(
        text: String,
        sourceLanguage: String,
        targetLanguage: String,
        words: List<TranslationWord>,
    ): SentenceTranslationResult {
        if (!enabled || provider != "openai" || apiKey.isNullOrBlank()) throw TranslationNotConfiguredException()
        val request = HttpRequest.newBuilder(URI.create("https://api.openai.com/v1/responses"))
            .timeout(Duration.ofSeconds(60))
            .header("Authorization", "Bearer $apiKey")
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(
                createOpenAiTranslationRequest(text, sourceLanguage, targetLanguage, words, model).toString(),
            ))
            .build()
        val response = try {
            client.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (_: Exception) {
            throw IllegalStateException("Translation provider request failed")
        }
        if (response.statusCode() !in 200..299) throw IllegalStateException("Translation provider request failed")
        return extractTranslation(response.body(), words)
    }
}

internal fun createOpenAiTranslationRequest(
    text: String,
    sourceLanguage: String,
    targetLanguage: String,
    words: List<TranslationWord>,
    model: String,
): JsonObject = JsonObject().apply {
    addProperty("model", model)
    addProperty("store", false)
    if (model == "gpt-5-nano") add("reasoning", JsonObject().apply { addProperty("effort", "minimal") })
    addProperty("max_output_tokens", (words.size * 12 + 128).coerceIn(256, 4096))
    addProperty(
        "instructions",
        "Translate the entire text from the language identified by ISO code '$sourceLanguage' " +
            "to the language identified by ISO code '$targetLanguage' first. Treat the text as " +
            "one contextual sentence or sign, not as isolated words. Then give one concise " +
            "context-appropriate meaning in the target language for each supplied word in order, using the full " +
            "sentence as context. Do not add readings, dictionary alternatives, explanations, or " +
            "facts that are not present in the source. In wordMeanings, preserve each supplied " +
            "tokenIndex and surface exactly. Return JSON matching the requested schema.",
    )
    val input = JsonObject().apply {
        addProperty("sentence", text)
        add("words", JsonArray().apply {
            words.forEach { word ->
                add(JsonObject().apply {
                    addProperty("tokenIndex", word.tokenIndex)
                    addProperty("surface", word.surface)
                })
            }
        })
    }
    addProperty("input", input.toString())
    add("text", JsonObject().apply {
        add("format", JsonObject().apply {
            addProperty("type", "json_schema")
            addProperty("name", "sentence_and_word_meanings")
            addProperty("strict", true)
            add("schema", translationOutputSchema())
        })
    })
}

private fun translationOutputSchema() = JsonObject().apply {
    addProperty("type", "object")
    addProperty("additionalProperties", false)
    add("properties", JsonObject().apply {
        add("translation", JsonObject().apply {
            addProperty("type", "string")
            addProperty("description", "The natural translation of the complete sentence or sign.")
        })
        add("wordMeanings", JsonObject().apply {
            addProperty("type", "array")
            add("items", JsonObject().apply {
                addProperty("type", "object")
                addProperty("additionalProperties", false)
                add("properties", JsonObject().apply {
                    add("tokenIndex", JsonObject().apply { addProperty("type", "integer") })
                    add("surface", JsonObject().apply { addProperty("type", "string") })
                    add("text", JsonObject().apply {
                        addProperty("type", "string")
                        addProperty("description", "A short target-language meaning for this token in context.")
                    })
                })
                add("required", JsonArray().apply {
                    add("tokenIndex")
                    add("surface")
                    add("text")
                })
            })
        })
    })
    add("required", JsonArray().apply {
        add("translation")
        add("wordMeanings")
    })
}

internal fun extractTranslation(body: String, requestedWords: List<TranslationWord>): SentenceTranslationResult {
    val response = try {
        JsonParser.parseString(body).asJsonObject
    } catch (_: Exception) {
        throw IllegalStateException("Translation provider returned an invalid response")
    }
    if (response.get("status")?.asString != "completed") {
        throw IllegalStateException("Translation provider did not complete the response")
    }
    val outputText = response.get("output_text")?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isString }?.asString
        ?: response.getAsJsonArray("output")?.asSequence()
            ?.filter { it.isJsonObject && it.asJsonObject.get("type")?.asString == "message" }
            ?.flatMap { it.asJsonObject.getAsJsonArray("content")?.asSequence() ?: emptySequence() }
            ?.filter { it.isJsonObject && it.asJsonObject.get("type")?.asString == "output_text" }
            ?.mapNotNull { it.asJsonObject.get("text")?.takeIf { value -> value.isJsonPrimitive }?.asString }
            ?.joinToString("\n")
    val output = try {
        JsonParser.parseString(outputText).asJsonObject
    } catch (_: Exception) {
        throw IllegalStateException("Translation provider returned an invalid result")
    }
    val translation = output.get("translation")?.takeIf { it.isJsonPrimitive }?.asString?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: throw IllegalStateException("Translation provider returned no sentence translation")
    val wordMeanings = output.getAsJsonArray("wordMeanings")?.map { item ->
        val word = item.asJsonObject
        ContextualWordMeaning(
            tokenIndex = word.exactInt("tokenIndex"),
            surface = word.get("surface").asString,
            text = word.get("text").asString.trim(),
        )
    } ?: throw IllegalStateException("Translation provider returned no word meanings")
    val matchesRequest = wordMeanings.size == requestedWords.size && wordMeanings.zip(requestedWords).all { (meaning, word) ->
        meaning.tokenIndex == word.tokenIndex && meaning.surface == word.surface && meaning.text.isNotEmpty()
    }
    if (!matchesRequest) throw IllegalStateException("Translation provider returned mismatched word meanings")
    return SentenceTranslationResult(translation, wordMeanings)
}
