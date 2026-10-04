package yugen.analysis

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.concurrent.Executors

private val gson = GsonBuilder().serializeNulls().create()

fun main() {
    val dataDirectory = Path.of(System.getenv("YUGEN_ANALYSIS_DATA") ?: ".data")
    val host = System.getenv("YUGEN_ANALYSIS_HOST") ?: "127.0.0.1"
    val port = System.getenv("YUGEN_ANALYSIS_PORT")?.toIntOrNull() ?: 8080
    val engine = AnalysisEngine.load(dataDirectory)
    val translator = OpenAiSentenceTranslator()
    val server = HttpServer.create(InetSocketAddress(host, port), 0)
    server.executor = Executors.newFixedThreadPool(4)
    server.createContext("/v1/analyze") { exchange -> handleAnalyze(exchange, engine) }
    server.createContext("/v1/translate") { exchange -> handleTranslate(exchange, translator) }
    server.start()
    println("Yugen analysis listening on http://$host:$port/v1/analyze")
    Runtime.getRuntime().addShutdownHook(Thread {
        server.stop(1)
        engine.close()
    })
}

private data class TranslationRequest(
    val contractVersion: Int,
    val sourceLanguage: String,
    val targetLanguage: String,
    val text: String,
    val words: List<TranslationWord>,
)

private fun handleTranslate(exchange: HttpExchange, translator: OpenAiSentenceTranslator) {
    if (exchange.requestMethod != "POST") {
        respond(exchange, 405, mapOf("error" to "POST required"))
        return
    }
    if (exchange.requestURI.path != "/v1/translate") {
        respond(exchange, 404, mapOf("error" to "Not found"))
        return
    }
    val request = try {
        val body = exchange.requestBody.use { it.readNBytes(MAX_REQUEST_BYTES + 1) }
        require(body.size <= MAX_REQUEST_BYTES) { "request body is too large" }
        val json = JsonParser.parseString(body.toString(StandardCharsets.UTF_8)).asJsonObject
        TranslationRequest(
            contractVersion = json.exactInt("contractVersion"),
            sourceLanguage = json.get("sourceLanguage").asString,
            targetLanguage = json.get("targetLanguage").asString,
            text = json.get("text").asString,
            words = json.getAsJsonArray("words").map { word ->
                TranslationWord(
                    tokenIndex = word.asJsonObject.exactInt("tokenIndex"),
                    surface = word.asJsonObject.get("surface").asString,
                )
            },
        ).also {
            require(it.contractVersion == TRANSLATION_CONTRACT_VERSION) { "Unsupported contractVersion" }
            require(it.sourceLanguage.matches(LANGUAGE_CODE)) { "sourceLanguage must be a language code" }
            require(it.targetLanguage.matches(LANGUAGE_CODE)) { "targetLanguage must be a language code" }
            require(it.text.isNotBlank()) { "text must not be blank" }
            require(it.text.length <= MAX_TRANSLATION_LENGTH) { "text exceeds $MAX_TRANSLATION_LENGTH characters" }
            require(it.words.size <= MAX_TRANSLATION_LENGTH) { "too many words" }
            var cursor = 0
            var previousTokenIndex = -1
            it.words.forEach { word ->
                require(word.tokenIndex > previousTokenIndex) { "words must be in token order" }
                require(word.surface.isNotBlank()) { "word surface must not be blank" }
                val start = it.text.indexOf(word.surface, cursor)
                require(start >= 0) { "word surfaces must match the corrected text" }
                cursor = start + word.surface.length
                previousTokenIndex = word.tokenIndex
            }
        }
    } catch (error: IllegalArgumentException) {
        respond(exchange, 400, mapOf("error" to (error.message ?: "Invalid request")))
        return
    } catch (_: Exception) {
        respond(exchange, 400, mapOf("error" to "Invalid JSON request"))
        return
    }
    try {
        val result = translator.translate(request.text, request.sourceLanguage, request.targetLanguage, request.words)
        respond(exchange, 200, mapOf(
            "contractVersion" to TRANSLATION_CONTRACT_VERSION,
            "sourceLanguage" to request.sourceLanguage,
            "targetLanguage" to request.targetLanguage,
            "sourceText" to request.text,
            "translation" to result.translation,
            "wordMeanings" to result.wordMeanings,
        ))
    } catch (_: TranslationNotConfiguredException) {
        respond(exchange, 503, mapOf("error" to "Translation is not configured on this device"))
    } catch (_: Exception) {
        respond(exchange, 502, mapOf("error" to "Translation is temporarily unavailable"))
    }
}

private fun handleAnalyze(exchange: HttpExchange, engine: AnalysisEngine) {
    if (exchange.requestMethod != "POST") {
        respond(exchange, 405, mapOf("error" to "POST required"))
        return
    }
    if (exchange.requestURI.path != "/v1/analyze") {
        respond(exchange, 404, mapOf("error" to "Not found"))
        return
    }
    val request = try {
        val body = exchange.requestBody.use { it.readNBytes(MAX_REQUEST_BYTES + 1) }
        require(body.size <= MAX_REQUEST_BYTES) { "request body is too large" }
        val json = JsonParser.parseString(body.toString(StandardCharsets.UTF_8)).asJsonObject
        AnalyzeRequest(
            contractVersion = json.exactInt("contractVersion"),
            language = json.get("language").asString,
            text = json.get("text").asString,
        )
    } catch (error: IllegalArgumentException) {
        respond(exchange, 400, mapOf("error" to (error.message ?: "Invalid request")))
        return
    } catch (error: Exception) {
        respond(exchange, 400, mapOf("error" to "Invalid JSON request"))
        return
    }
    try {
        respond(exchange, 200, engine.analyze(request))
    } catch (error: IllegalArgumentException) {
        respond(exchange, 400, mapOf("error" to (error.message ?: "Invalid request")))
    } catch (error: Exception) {
        respond(exchange, 500, mapOf("error" to "Analysis failed"))
    }
}

private fun respond(exchange: HttpExchange, status: Int, body: Any) {
    val bytes = gson.toJson(body).toByteArray(StandardCharsets.UTF_8)
    exchange.responseHeaders.set("Content-Type", "application/json; charset=utf-8")
    exchange.sendResponseHeaders(status, bytes.size.toLong())
    exchange.responseBody.use { it.write(bytes) }
}

/** Reads a JSON number without truncating fractions or wrapping integer overflow. */
internal fun JsonObject.exactInt(name: String): Int {
    val value = get(name)
    require(value != null && value.isJsonPrimitive && value.asJsonPrimitive.isNumber) {
        "$name must be an integer"
    }
    return try {
        value.asBigDecimal.intValueExact()
    } catch (_: ArithmeticException) {
        throw IllegalArgumentException("$name must be an integer in the 32-bit range")
    }
}

private const val MAX_REQUEST_BYTES = 16_384
private const val MAX_TRANSLATION_LENGTH = 2_000
private const val TRANSLATION_CONTRACT_VERSION = 2
private val LANGUAGE_CODE = Regex("[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*")
