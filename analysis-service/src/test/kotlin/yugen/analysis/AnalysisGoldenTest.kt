package yugen.analysis

import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class AnalysisGoldenTest {
    companion object {
        private var engine: AnalysisEngine? = null

        @org.junit.jupiter.api.BeforeAll
        @JvmStatic
        fun loadRealData() {
            val dataDirectory = Path.of(System.getenv("YUGEN_ANALYSIS_DATA") ?: ".data")
            engine = AnalysisEngine.load(dataDirectory)
        }

        @org.junit.jupiter.api.AfterAll
        @JvmStatic
        fun closeEngine() {
            engine?.close()
        }
    }

    @Test
    fun convertsSudachiKatakanaReadingsToHiragana() {
        assertEquals("かたかな とーきょー ゝゞ", AnalysisEngine.toHiragana("カタカナ トーキョー ヽヾ"))
    }

    @Test
    fun automaticFuriganaUsesTheParserForSentencesButKeepsLexicalHintsOtherwise() {
        val recommended = DictionaryCandidate("rice:こめ", "こめ", listOf("rice"), recommended = true)

        assertEquals("べい", automaticFuriganaReading("べい", listOf(recommended), sentenceContext = true))
        assertEquals(null, automaticFuriganaReading(null, listOf(recommended), sentenceContext = true))
        assertEquals("こめ", automaticFuriganaReading("べい", listOf(recommended), sentenceContext = false))
        assertEquals("こめ", automaticFuriganaReading(null, listOf(recommended), sentenceContext = false))
        assertEquals(null, automaticFuriganaReading(null, listOf(
            recommended.copy(recommended = false),
            DictionaryCandidate("america:べい", "べい", listOf("America")),
        ), sentenceContext = true))
    }

    @Test
    fun goldenJapaneseLineIncludesRealReadingsGlossesAndScriptUnits() {
        val originalText = "鶏肉をください。"
        val request = AnalyzeRequest(contractVersion = 2, language = "ja", text = originalText)
        val response = checkNotNull(engine).analyze(request)

        assertEquals(2, response.contractVersion)
        assertEquals("ja", response.language)
        assertEquals(originalText, response.normalizedText)
        assertEquals(originalText, request.text)
        assertEquals(listOf("鶏肉", "を", "ください", "。"), response.tokens.map(AnalyzedToken::surface))

        val chicken = response.tokens.first()
        assertEquals("鶏肉", chicken.lemma)
        assertEquals("けいにく", chicken.reading, chicken.toString())
        assertEquals("名詞", chicken.partOfSpeech)
        assertTrue(chicken.dictionaryCandidates.any { it.meanings.contains("chicken meat") })
        assertTrue(chicken.dictionaryCandidates.any { it.reading == "とりにく" && !it.recommended })
        assertTrue(chicken.dictionaryCandidates.any { it.reading == "けいにく" })
        assertTrue(chicken.dictionaryCandidates.none { it.recommended })
        assertEquals(listOf("鶏", "肉"), chicken.scriptUnits)
        assertTrue(response.tokens.all { token -> token.reading == null || token.reading == AnalysisEngine.toHiragana(token.reading) })
    }

    @Test
    fun kinmemaiLabelUsesItsRiceReadingAndMeaning() {
        val response = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "金芽米使用"),
        )
        val kinmemai = response.tokens.first()

        assertEquals("金芽米", kinmemai.surface)
        assertEquals("きんめまい", kinmemai.reading)
        assertEquals("Kinmemai rice", kinmemai.curatedMeaning)
        assertTrue(kinmemai.dictionaryCandidates.isEmpty())
    }

    @Test
    fun representativeRicePackageTextProvidesFuriganaForEveryKanjiToken() {
        val text = "金芽米使用 消費期限 保存温度 白飯 栄養成分表示"
        val response = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = text),
        )
        val kanjiTokens = response.tokens.filter { token ->
            token.surface.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }
        }

        assertTrue(kanjiTokens.isNotEmpty())
        assertTrue(kanjiTokens.all { !it.reading.isNullOrBlank() }, "Kanji tokens missing furigana: $kanjiTokens")
        assertTrue(kanjiTokens.all { it.reading == AnalysisEngine.toHiragana(it.reading!!) }, "Readings must be hiragana: $kanjiTokens")
    }

    @Test
    fun americaCompoundKeepsItsAmericaMeaning() {
        val response = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "米国"),
        )

        assertTrue(response.tokens.any { token -> token.dictionaryCandidates.any { candidate -> candidate.meanings.any { it.contains("America", ignoreCase = true) || it.contains("USA", ignoreCase = true) } } })
    }

    @Test
    fun singleKanjiPreservesItsRiceAndAmericaLexicalCandidatesWithTheirOwnReadings() {
        listOf("米", "米。").forEach { text ->
            val rice = checkNotNull(engine).analyze(
                AnalyzeRequest(contractVersion = 2, language = "ja", text = text),
            ).tokens.first { it.surface == "米" }

            assertTrue(rice.dictionaryCandidates.any { candidate ->
                candidate.reading == "こめ" && candidate.recommended && candidate.meanings.any { it.contains("rice", ignoreCase = true) }
            }, "Rice entry missing for '$text': ${rice.dictionaryCandidates}")
            assertTrue(rice.dictionaryCandidates.any { candidate ->
                candidate.reading == "べい" && !candidate.recommended && candidate.meanings.any { it.contains("America", ignoreCase = true) || it.contains("USA", ignoreCase = true) }
            }, "America entry missing for '$text': ${rice.dictionaryCandidates}")
            assertEquals("こめ", rice.reading, text)
            assertEquals(null, rice.curatedMeaning, rice.toString())
        }
    }

    @Test
    fun sentenceContextDoesNotTurnDictionaryCommonnessIntoAConfirmedMeaning() {
        listOf("ご飯に米を使います。", "米を批判した").forEach { text ->
            val rice = checkNotNull(engine).analyze(
                AnalyzeRequest(contractVersion = 2, language = "ja", text = text),
            ).tokens.first { it.surface == "米" }

            assertTrue(rice.dictionaryCandidates.any { candidate ->
                candidate.reading == "こめ" && candidate.meanings.any { it.contains("rice", ignoreCase = true) }
            }, "Rice entry missing for '$text': ${rice.dictionaryCandidates}")
            assertTrue(rice.dictionaryCandidates.any { candidate ->
                candidate.reading == "べい" && candidate.meanings.any { it.contains("America", ignoreCase = true) || it.contains("USA", ignoreCase = true) }
            }, "America entry missing for '$text': ${rice.dictionaryCandidates}")
            assertTrue(rice.dictionaryCandidates.none { it.recommended }, "Context should not be inferred from word frequency: ${rice.dictionaryCandidates}")
            assertTrue(!rice.reading.isNullOrBlank(), "Sentence furigana should retain Sudachi's contextual reading for '$text'")
            assertTrue(rice.reading == "こめ" || rice.reading == "べい", "Reading should be a real Japanese reading, not a gloss: ${rice.toString()}")
        }
    }

    @Test
    fun americaAbbreviationBeforePresidentRetainsContextReadingWithoutConfirmingSense() {
        val america = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "米大統領"),
        ).tokens.first()

        assertEquals("べい", america.reading, "Sudachi's contextual reading should remain visible as furigana")
        assertTrue(america.dictionaryCandidates.any { candidate -> candidate.reading == "べい" && candidate.meanings.any { it.contains("America", ignoreCase = true) || it.contains("USA", ignoreCase = true) } })
    }

    @Test
    fun kanjiInARepresentativeSentenceKeepSudachiFuriganaEvenWhenSensesCompete() {
        val response = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "ご飯に米を使います。"),
        )
        val kanjiTokens = response.tokens.filter { token -> token.surface.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN } }

        assertTrue(kanjiTokens.isNotEmpty())
        assertTrue(kanjiTokens.all { !it.reading.isNullOrBlank() }, "Every parsed kanji token should expose a parser reading: $kanjiTokens")
    }

    @Test
    fun americaAbbreviationWithAnObjectParticleIsNotForcedToRice() {
        val america = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "米を批判した"),
        ).tokens.first()

        assertTrue(america.dictionaryCandidates.any { candidate -> candidate.reading == "べい" && candidate.meanings.any { it.contains("America", ignoreCase = true) || it.contains("USA", ignoreCase = true) } })
    }

    @Test
    fun commonSentenceDoesNotOfferHomophoneNounSensesForGrammarOrInflections() {
        val response = checkNotNull(engine).analyze(
            AnalyzeRequest(contractVersion = 2, language = "ja", text = "ご飯に米を使います。"),
        )
        val particle = response.tokens.single { it.surface == "に" }
        val verb = response.tokens.single { it.surface.contains("使") }
        val auxiliary = response.tokens.single { it.surface == "ます" }

        assertFalse(particle.dictionaryCandidates.any { it.meanings.any { meaning -> meaning.contains("baggage", ignoreCase = true) || meaning.contains("load", ignoreCase = true) } }, particle.toString())
        assertTrue(verb.dictionaryCandidates.any { candidate -> candidate.meanings.any { it.contains("use", ignoreCase = true) } }, verb.toString())
        assertFalse(verb.dictionaryCandidates.any { candidate -> candidate.meanings.any { it.contains("errand", ignoreCase = true) || it.contains("messenger", ignoreCase = true) } }, verb.toString())
        assertFalse(auxiliary.dictionaryCandidates.any { candidate -> candidate.meanings.any { it.contains("measuring container", ignoreCase = true) } }, auxiliary.toString())
    }

    @Test
    fun rejectsUnsupportedContractVersions() {
        val failure = runCatching {
            checkNotNull(engine).analyze(AnalyzeRequest(contractVersion = 1, language = "ja", text = "猫"))
        }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
    }

    @Test
    fun realDictionaryKeepsCharacterDefinitionsSeparateFromCompoundGlosses() {
        val word = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "鶏肉")).tokens.single()
        assertEquals(listOf("鶏", "肉"), word.kanjiDetails.map(KanjiDetails::character))
        assertTrue(word.kanjiDetails[0].meanings.any { it == "chicken" || it == "domestic fowl" })
        assertTrue(word.kanjiDetails[1].meanings.contains("meat"))
        assertTrue(word.kanjiDetails[1].onReadings.contains("ニク"))
        assertTrue(word.dictionaryCandidates.any { "chicken meat" in it.meanings })
    }

    @Test
    fun basicKanjiInAnN5ListKeepTheirExactWrittenDictionaryEntriesWhenTheParserTagsThemAsSuffixes() {
        // Actual phone OCR line: Sudachi tags 雨/魚 as suffixes (う/ぎょ) and no JMdict suffix sense exists.
        val tokens = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "長間雨電食飲駅高魚")).tokens
        val rain = tokens.single { it.surface == "雨" }
        val fish = tokens.single { it.surface == "魚" }

        assertTrue(rain.dictionaryCandidates.any { it.reading == "あめ" && "rain" in it.meanings }, rain.toString())
        assertEquals("あめ", rain.reading, "The unsupported suffix reading う must not be shown as furigana")
        assertTrue(fish.dictionaryCandidates.any { it.reading == "さかな" && "fish" in it.meanings }, fish.toString())
        assertTrue(fish.dictionaryCandidates.any { it.reading == "うお" }, fish.toString())
        assertTrue(fish.reading != "ぎょ", "Two dictionary readings remain a choice, not the suffix reading: $fish")
        assertTrue((tokens.flatMap { it.dictionaryCandidates }).none { it.recommended }, "A list is context; nothing is auto-confirmed")
        assertTrue(tokens.filter { it.scriptUnits.isNotEmpty() }.all { it.kanjiDetails.isNotEmpty() }, "Every kanji keeps its character evidence")

        val wider = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "会何先入八六円出分前北十千")).tokens
        assertTrue(wider.single { it.surface == "千" }.dictionaryCandidates.any { "thousand" in it.meanings }, wider.toString())
        assertEquals("電食", tokens.single { it.surface.startsWith("電") }.surface, "Compounds are not split into characters")
        assertTrue(rain.writtenFormEvidence && fish.writtenFormEvidence, "Fallback entries are labeled as written-form evidence")
        assertTrue(tokens.filter { it.surface == "駅" || it.surface == "電食" }.none { it.writtenFormEvidence })
        val short = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "間雨")).tokens.single { it.surface == "雨" }
        assertTrue(short.dictionaryCandidates.any { "rain" in it.meanings }, short.toString())
        listOf("雨天", "大雨").forEach { compound ->
            val token = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", compound)).tokens.single()
            assertEquals(compound, token.surface)
            assertTrue(!token.writtenFormEvidence && token.dictionaryCandidates.isNotEmpty(), token.toString())
        }
    }

    @Test
    fun proseKeepsItsPartOfSpeechFilteringForTheSameCharacters() {
        val tokens = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "魚を食べます。雨が降ります。")).tokens
        assertEquals("さかな", tokens.first { it.surface == "魚" }.reading)
        assertEquals("あめ", tokens.first { it.surface == "雨" }.reading)
        val particle = tokens.first { it.surface == "を" }
        assertTrue(particle.dictionaryCandidates.all { candidate -> candidate.meanings.none { it.contains("fish", ignoreCase = true) } })
        assertEquals("たべ", tokens.first { it.surface == "食べ" }.reading, "Inflected surfaces keep the parser reading")
    }

    @Test
    fun isolatedInflectionKeepsSurfaceFuriganaWhileDictionaryUsesItsLemmaReading() {
        val token = checkNotNull(engine).analyze(AnalyzeRequest(2, "ja", "ください")).tokens.single()
        assertEquals("くださる", token.lemma)
        assertEquals("ください", token.reading)
        assertTrue(token.dictionaryCandidates.any { it.reading == "くださる" })
    }

}
