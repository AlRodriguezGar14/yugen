package yugen.analysis

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.helpers.DefaultHandler
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import javax.xml.XMLConstants
import javax.xml.parsers.SAXParserFactory

/** Character dictionary data; these readings do not specify a compound's pronunciation. */
data class KanjiDetails(
    val character: String,
    val meanings: List<String> = emptyList(),
    val onReadings: List<String> = emptyList(),
    val kunReadings: List<String> = emptyList(),
)

internal class KanjidicGlossary private constructor(private val entries: Map<String, KanjiDetails>) {
    fun lookup(characters: List<String>): List<KanjiDetails> =
        characters.map { entries[it] ?: KanjiDetails(it) }

    companion object {
        fun load(path: Path): KanjidicGlossary {
            check(Files.isRegularFile(path)) { "KANJIDIC2 is missing. Run analysis-service/scripts/setup-data.sh" }
            val handler = Handler()
            GZIPInputStream(Files.newInputStream(path)).use { input ->
                val factory = SAXParserFactory.newInstance()
                factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
                factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
                factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
                factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
                factory.newSAXParser().parse(InputSource(input), handler)
            }
            check(handler.entries.isNotEmpty()) { "KANJIDIC2 contains no character entries" }
            return KanjidicGlossary(handler.entries)
        }

        private class Handler : DefaultHandler() {
            val entries = LinkedHashMap<String, KanjiDetails>()
            private var character = ""
            private val meanings = ArrayList<String>()
            private val onReadings = ArrayList<String>()
            private val kunReadings = ArrayList<String>()
            private var readingType: String? = null
            private var meaningLanguage: String? = null
            private val text = StringBuilder()

            override fun startElement(uri: String, localName: String, qName: String, attributes: Attributes) {
                text.setLength(0)
                when (qName) {
                    "character" -> { character = ""; meanings.clear(); onReadings.clear(); kunReadings.clear() }
                    "reading" -> readingType = attributes.getValue("r_type")
                    "meaning" -> meaningLanguage = attributes.getValue("m_lang")
                }
            }

            override fun characters(ch: CharArray, start: Int, length: Int) {
                text.append(ch, start, length)
            }

            override fun endElement(uri: String, localName: String, qName: String) {
                val value = text.toString().trim()
                when (qName) {
                    "literal" -> character = value
                    "reading" -> when (readingType) {
                        "ja_on" -> if (value.isNotEmpty()) onReadings.add(value)
                        "ja_kun" -> if (value.isNotEmpty()) kunReadings.add(value)
                    }
                    "meaning" -> if ((meaningLanguage == null || meaningLanguage == "en") && value.isNotEmpty()) meanings.add(value)
                    "character" -> if (character.codePointCount(0, character.length) == 1) {
                        entries[character] = KanjiDetails(character, meanings.distinct(), onReadings.distinct(), kunReadings.distinct())
                    }
                }
            }
        }
    }
}
