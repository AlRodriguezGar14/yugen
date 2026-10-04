package yugen.analysis

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.helpers.DefaultHandler
import java.nio.file.Files
import java.nio.file.Path
import java.util.zip.GZIPInputStream
import javax.xml.XMLConstants
import javax.xml.parsers.SAXParserFactory

data class DictionaryCandidate(
    val id: String,
    val reading: String,
    val meanings: List<String>,
    val recommended: Boolean = false,
)

internal class JmdictGlossary private constructor(
    private val entriesByForm: Map<String, List<Entry>>,
) {
    fun lookup(surface: String, lemma: String, reading: String?, partOfSpeech: String): List<DictionaryCandidate> {
        val forms = setOf(surface, lemma, reading).filterNotNull().toSet()
        val candidates = forms.asSequence()
            .flatMap { entriesByForm[it].orEmpty().asSequence() }
            .distinctBy(Entry::sequence)
            .toList()
        val exactOrthography = candidates.filter { entry ->
            entry.kanji.any { it == surface || it == lemma } ||
                (entry.kanji.isEmpty() && entry.readings.any { it.form == surface || it.form == lemma })
        }
        val ranked = (exactOrthography.ifEmpty { candidates }).asSequence()
            .flatMap { it.candidatesFor(surface, lemma, reading, partOfSpeech).asSequence() }
            .distinctBy { it.candidate.id }
            .sortedByDescending(RankedCandidate::priority)
            .toList()
        val bestPriority = ranked.firstOrNull()?.priority ?: Priority(0, 0)
        val bestCandidates = ranked.count { it.priority == bestPriority }
        return ranked.map { rankedCandidate ->
            rankedCandidate.candidate.copy(
                recommended = bestPriority > Priority(0, 0) && bestCandidates == 1 && rankedCandidate.priority == bestPriority,
            )
        }
    }

    private data class RankedCandidate(val candidate: DictionaryCandidate, val priority: Priority)
    private data class Priority(val writtenForm: Int, val reading: Int) : Comparable<Priority> {
        override fun compareTo(other: Priority): Int =
            compareValuesBy(this, other, Priority::writtenForm, Priority::reading)
    }

    private data class Reading(
        val form: String,
        val kanjiRestrictions: Set<String>,
        val noKanji: Boolean,
        val priorities: Set<String>,
    )

    private data class Sense(
        val kanjiRestrictions: Set<String>,
        val readingRestrictions: Set<String>,
        val partsOfSpeech: Set<String>,
        val glosses: List<String>,
    )

    private data class Entry(
        val sequence: String,
        val kanji: Set<String>,
        val kanjiPriorities: Map<String, Set<String>>,
        val readings: List<Reading>,
        val senses: List<Sense>,
    ) {
        fun candidatesFor(
            surface: String,
            lemma: String,
            requestedReading: String?,
            requestedPartOfSpeech: String,
        ): List<RankedCandidate> {
            val matchedKanji = kanji.firstOrNull { it == surface || it == lemma }
            val matchingReadings = readings.filter { variant ->
                val kanjiAllowed = matchedKanji == null ||
                    (!variant.noKanji &&
                        (variant.kanjiRestrictions.isEmpty() ||
                            matchedKanji in variant.kanjiRestrictions))
                val formMatches = variant.form == surface || variant.form == lemma ||
                    (requestedReading != null && variant.form == requestedReading)
                val exactKanjiMatch = matchedKanji != null
                (exactKanjiMatch || formMatches) && kanjiAllowed
            }
            return matchingReadings.mapNotNull { variant ->
                val meanings = senses.asSequence()
                    .filter { sense ->
                        (sense.kanjiRestrictions.isEmpty() ||
                            (matchedKanji != null && matchedKanji in sense.kanjiRestrictions)) &&
                            (sense.readingRestrictions.isEmpty() ||
                                variant.form in sense.readingRestrictions) &&
                            sense.matchesPartOfSpeech(requestedPartOfSpeech)
                    }
                    .flatMap { it.glosses.asSequence() }
                    .distinct()
                    .toList()
                if (meanings.isEmpty()) null else RankedCandidate(
                    candidate = DictionaryCandidate(
                        id = "$sequence:${variant.form}",
                        reading = variant.form,
                        meanings = meanings,
                    ),
                    priority = Priority(
                        writtenForm = matchedKanji?.let { priorityScore(kanjiPriorities[it].orEmpty()) } ?: 0,
                        reading = priorityScore(variant.priorities),
                    ),
                )
            }
        }

        private fun priorityScore(priorities: Set<String>): Int = when {
            priorities.any { it == "ichi1" || it == "news1" } -> 3
            priorities.any { it == "gai1" || it == "spec1" } -> 2
            priorities.any { it == "ichi2" || it == "news2" || it == "gai2" || it == "spec2" } -> 1
            else -> 0
        }

        private fun Sense.matchesPartOfSpeech(requested: String): Boolean {
            if (partsOfSpeech.isEmpty()) return false
            val tags = partsOfSpeech.map(String::lowercase)
            return when (requested) {
                "名詞" -> tags.any { "noun" in it || "pronoun" in it || "counter" in it || "numeral" in it }
                "動詞" -> tags.any { "verb" in it && "auxiliary" !in it && "adverb" !in it }
                "形容詞", "形状詞" -> tags.any { "adjective" in it }
                "副詞" -> tags.any { "adverb" in it }
                "助詞" -> tags.any { "particle" in it }
                "助動詞" -> tags.any { "auxiliary" in it }
                "接続詞" -> tags.any { "conjunction" in it }
                "連体詞" -> tags.any { "pre-noun adjectival" in it || "no-adjective" in it }
                "感動詞" -> tags.any { "interjection" in it }
                "接頭辞" -> tags.any { "prefix" in it }
                "接尾辞" -> tags.any { "suffix" in it }
                else -> false
            }
        }
    }

    companion object {
        fun load(path: Path): JmdictGlossary {
            val handler = JmdictHandler()
            GZIPInputStream(Files.newInputStream(path)).use { input ->
                secureSaxParser().parse(InputSource(input), handler)
            }
            return JmdictGlossary(handler.entries.mapValues { it.value.toList() })
        }

        private fun secureSaxParser(): javax.xml.parsers.SAXParser {
            val factory = SAXParserFactory.newInstance()
            factory.isNamespaceAware = true
            factory.isXIncludeAware = false
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
            factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
            return factory.newSAXParser().apply {
                // JMdict's trusted internal DTD expands POS entities throughout the file.
                setProperty("http://www.oracle.com/xml/jaxp/properties/entityExpansionLimit", "2000000")
            }
        }

        private class JmdictHandler : DefaultHandler() {
            private val frames = ArrayDeque<Frame>()
            private var entry: EntryBuilder? = null
            private var kanjiForm: KanjiBuilder? = null
            private var reading: ReadingBuilder? = null
            private var sense: SenseBuilder? = null
            val entries = LinkedHashMap<String, MutableList<Entry>>()

            override fun startElement(uri: String, localName: String, qName: String, attributes: Attributes) {
                val name = localName.ifEmpty { qName.substringAfter(':') }
                if (name == "entry") entry = EntryBuilder()
                if (name == "k_ele") kanjiForm = KanjiBuilder()
                if (name == "r_ele") reading = ReadingBuilder()
                if (name == "sense") sense = SenseBuilder()
                val language = attributes.getValue(XMLConstants.XML_NS_URI, "lang")
                    ?: attributes.getValue("xml:lang")
                frames.addLast(Frame(name, StringBuilder(), language))
            }

            override fun characters(ch: CharArray, start: Int, length: Int) {
                frames.lastOrNull()?.text?.append(ch, start, length)
            }

            override fun endElement(uri: String, localName: String, qName: String) {
                val frame = frames.removeLast()
                val value = frame.text.toString().trim()
                when (frame.name) {
                    "keb" -> kanjiForm?.form = value
                    "ke_pri" -> kanjiForm?.priorities?.add(value)
                    "k_ele" -> kanjiForm?.let { entry?.addKanji(it.build()) }.also { kanjiForm = null }
                    "reb" -> reading?.form = value
                    "re_restr" -> reading?.kanjiRestrictions?.add(value)
                    "re_nokanji" -> reading?.noKanji = true
                    "re_pri" -> reading?.priorities?.add(value)
                    "r_ele" -> reading?.let { entry?.readings?.add(it.build()) }.also { reading = null }
                    "stagk" -> sense?.kanjiRestrictions?.add(value)
                    "stagr" -> sense?.readingRestrictions?.add(value)
                    "pos" -> sense?.partsOfSpeech?.add(value)
                    "gloss" -> if (frame.language.isNullOrBlank() || frame.language == "eng") {
                        sense?.glosses?.add(value)
                    }
                    "sense" -> sense?.let { entry?.senses?.add(it.build()) }.also { sense = null }
                    "ent_seq" -> entry?.sequence = value
                    "entry" -> entry?.build()?.let(::addEntry).also { entry = null }
                }
            }

            private fun addEntry(entry: Entry) {
                if (entry.sequence.isBlank()) return
                val forms = entry.kanji + entry.readings.map(Reading::form)
                forms.forEach { form -> entries.getOrPut(form, ::ArrayList).add(entry) }
            }

            private data class Frame(val name: String, val text: StringBuilder, val language: String?)
            private data class KanjiForm(val form: String, val priorities: Set<String>)

            private class KanjiBuilder {
                var form = ""
                val priorities = LinkedHashSet<String>()
                fun build() = KanjiForm(form, priorities)
            }

            private class EntryBuilder {
                var sequence = ""
                val kanji = LinkedHashSet<String>()
                val kanjiPriorities = LinkedHashMap<String, Set<String>>()
                val readings = ArrayList<Reading>()
                val senses = ArrayList<Sense>()
                fun addKanji(form: KanjiForm) {
                    if (form.form.isBlank()) return
                    kanji.add(form.form)
                    kanjiPriorities[form.form] = form.priorities
                }
                fun build() = Entry(sequence, kanji, kanjiPriorities, readings, senses)
            }

            private class ReadingBuilder {
                var form = ""
                var noKanji = false
                val kanjiRestrictions = LinkedHashSet<String>()
                val priorities = LinkedHashSet<String>()
                fun build() = Reading(form, kanjiRestrictions, noKanji, priorities)
            }

            private class SenseBuilder {
                val kanjiRestrictions = LinkedHashSet<String>()
                val readingRestrictions = LinkedHashSet<String>()
                val partsOfSpeech = LinkedHashSet<String>()
                val glosses = ArrayList<String>()
                fun build() = Sense(kanjiRestrictions, readingRestrictions, partsOfSpeech, glosses)
            }
        }
    }
}
