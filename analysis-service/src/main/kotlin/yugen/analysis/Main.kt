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
    val server = HttpServer.create(InetSocketAddress(host, port), 0)
    server.executor = Executors.newFixedThreadPool(4)
    server.createContext("/v1/analyze") { exchange -> handleAnalyze(exchange, engine) }
    server.start()
    println("Yugen analysis listening on http://$host:$port/v1/analyze")
    Runtime.getRuntime().addShutdownHook(Thread {
        server.stop(1)
        engine.close()
    })
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
