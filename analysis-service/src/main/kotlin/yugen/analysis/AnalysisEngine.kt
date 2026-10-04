package yugen.analysis

import com.worksap.nlp.sudachi.Config
import com.worksap.nlp.sudachi.Dictionary
import com.worksap.nlp.sudachi.DictionaryFactory
import com.worksap.nlp.sudachi.Tokenizer
import java.io.Closeable
import java.nio.file.Files
import java.nio.file.Path

private const val ANALYSIS_CONTRACT_VERSION = 2

data class AnalyzeRequest(
    val contractVersion: Int,
    val language: String,
    val text: String,
)

data class AnalyzeResponse(
    val contractVersion: Int = ANALYSIS_CONTRACT_VERSION,
    val language: String,
    val normalizedText: String,
    val tokens: List<AnalyzedToken>,
)

data class AnalyzedToken(
    val surface: String,
    val lemma: String,
    val reading: String?,
    val partOfSpeech: String,
    val dictionaryCandidates: List<DictionaryCandidate>,
    val curatedMeaning: String? = null,
    val scriptUnits: List<String>,
    val kanjiDetails: List<KanjiDetails> = emptyList(),
)

class AnalysisEngine private constructor(
    private val dictionary: Dictionary,
    private val glossary: JmdictGlossary,
    private val kanjiGlossary: KanjidicGlossary,
) : Closeable {
    fun analyze(request: AnalyzeRequest): AnalyzeResponse {
        require(request.contractVersion == CONTRACT_VERSION) { "Unsupported contractVersion" }
        require(request.language == "ja") { "Only language 'ja' is supported" }
        require(request.text.isNotBlank()) { "text must not be blank" }
        require(request.text.length <= MAX_TEXT_LENGTH) { "text exceeds $MAX_TEXT_LENGTH characters" }

        val morphemes = dictionary.create().tokenize(Tokenizer.SplitMode.B, request.text)
        val lexicalTokenCount = morphemes.count {
            it.surface().isNotBlank() && it.partOfSpeech().firstOrNull() != "補助記号"
        }
        val tokens = ArrayList<AnalyzedToken>(morphemes.size)
        var index = 0
        while (index < morphemes.size) {
            val knownTerm = knownTermAt(morphemes, index)
            if (knownTerm != null) {
                tokens.add(knownTerm.first.toToken())
                index += knownTerm.second
                continue
            }

            val morpheme = morphemes[index]
            val surface = morpheme.surface()
            val lemma = morpheme.dictionaryForm()
            val parserReading = morpheme.readingForm()
                .takeIf { it.isNotBlank() && it != "*" }
                ?.let(::toHiragana)
            val partOfSpeech = morpheme.partOfSpeech().firstOrNull().orEmpty()
            val dictionaryCandidates = glossary.lookup(surface, lemma, parserReading, partOfSpeech)
            val sentenceContext = lexicalTokenCount > 1
            val candidates = if (sentenceContext) {
                dictionaryCandidates.map { it.copy(recommended = false) }
            } else {
                dictionaryCandidates
            }
            // A lemma reading cannot pronounce an inflected surface (ください ≠ くださる).
            val reading = if (surface != lemma) {
                parserReading
            } else {
                automaticFuriganaReading(parserReading, candidates, sentenceContext)
            }
            tokens.add(AnalyzedToken(
                surface = surface,
                lemma = lemma,
                reading = reading,
                partOfSpeech = partOfSpeech,
                dictionaryCandidates = candidates,
                scriptUnits = kanjiUnits(surface),
            ))
            index += 1
        }
        return AnalyzeResponse(
            language = request.language,
            normalizedText = request.text,
            tokens = tokens.map { it.copy(kanjiDetails = kanjiGlossary.lookup(it.scriptUnits)) },
        )
    }

    override fun close() {
        dictionary.close()
    }

    companion object {
        const val CONTRACT_VERSION = ANALYSIS_CONTRACT_VERSION
        const val MAX_TEXT_LENGTH = 2_000
        private const val SUDACHI_DIRECTORY = "sudachi-dictionary-20260116"
        private val knownTerms = listOf(
            // Sudachi core/full both split this registered rice name into misleading single-kanji entries.
            KnownTerm("金芽米", "きんめまい", "Kinmemai rice"),
        )

        fun load(dataDirectory: Path): AnalysisEngine {
            val dictionaryPath = findSystemDictionary(dataDirectory)
            val jmdictPath = dataDirectory.resolve("JMdict_e_NG.gz")
            check(Files.isRegularFile(jmdictPath)) {
                "JMdict is missing. Run analysis-service/scripts/setup-data.sh"
            }
            val kanjiGlossary = KanjidicGlossary.load(dataDirectory.resolve("kanjidic2.xml.gz"))
            val glossary = JmdictGlossary.load(jmdictPath)
            val dictionary = DictionaryFactory().create(
                Config.defaultConfig().systemDictionary(dictionaryPath),
            )
            return AnalysisEngine(dictionary, glossary, kanjiGlossary)
        }

        private fun findSystemDictionary(dataDirectory: Path): Path {
            val path = dataDirectory.resolve(SUDACHI_DIRECTORY).resolve("system_core.dic")
            check(Files.isRegularFile(path)) {
                "Sudachi system_core.dic is missing. Run analysis-service/scripts/setup-data.sh"
            }
            return path
        }

        private fun knownTermAt(
            morphemes: List<com.worksap.nlp.sudachi.Morpheme>,
            start: Int,
        ): Pair<KnownTerm, Int>? {
            return knownTerms.firstNotNullOfOrNull { term ->
                var matched = ""
                var consumed = 0
                var index = start
                while (index < morphemes.size && term.surface.startsWith(matched)) {
                    matched += morphemes[index].surface()
                    if (!term.surface.startsWith(matched)) break
                    consumed += 1
                    if (matched == term.surface) return@firstNotNullOfOrNull term to consumed
                    index += 1
                }
                null
            }
        }

        internal fun toHiragana(reading: String): String = buildString(reading.length) {
            reading.codePoints().forEach { codePoint ->
                val hiragana = when (codePoint) {
                    in 0x30A1..0x30F6 -> codePoint - 0x60
                    0x30FD -> 0x309D
                    0x30FE -> 0x309E
                    else -> codePoint
                }
                appendCodePoint(hiragana)
            }
        }

        private fun kanjiUnits(text: String): List<String> {
            val result = LinkedHashSet<String>()
            text.codePoints().forEach { codePoint ->
                if (isKanji(codePoint)) result.add(String(Character.toChars(codePoint)))
            }
            return result.toList()
        }

        private fun isKanji(codePoint: Int): Boolean =
            codePoint in 0x3400..0x4DBF ||
                codePoint in 0x4E00..0x9FFF ||
                codePoint in 0xF900..0xFAFF ||
                codePoint in 0x20000..0x2A6DF ||
                codePoint in 0x2A700..0x2B73F ||
                codePoint in 0x2B740..0x2B81F ||
                codePoint in 0x2B820..0x2CEAF ||
                codePoint in 0x2CEB0..0x2EBEF ||
                codePoint in 0x2F800..0x2FA1F ||
                codePoint in 0x30000..0x323AF

        private data class KnownTerm(
            val surface: String,
            val reading: String,
            val meaning: String,
        ) {
            fun toToken() = AnalyzedToken(
                surface = surface,
                lemma = surface,
                reading = reading,
                partOfSpeech = "名詞",
                dictionaryCandidates = emptyList(),
                curatedMeaning = meaning,
                scriptUnits = kanjiUnits(surface),
            )
        }
    }
}

internal fun automaticFuriganaReading(
    parserReading: String?,
    dictionaryCandidates: List<DictionaryCandidate>,
    sentenceContext: Boolean,
): String? {
    val parser = parserReading?.takeIf(String::isNotBlank)
    if (sentenceContext) return parser

    val uniqueReading = dictionaryCandidates.map(DictionaryCandidate::reading).distinct().singleOrNull()
    val recommended = dictionaryCandidates.filter(DictionaryCandidate::recommended)
        .map(DictionaryCandidate::reading).distinct().singleOrNull()
    return uniqueReading ?: recommended
        ?: parser
}
