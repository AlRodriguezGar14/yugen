package yugen.analysis

import java.nio.file.Files
import java.util.zip.GZIPOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals

class KanjidicGlossaryTest {
    @Test
    fun preservesJapaneseReadingTypesAndEnglishMeaningsWithoutExternalEntities() {
        val file = Files.createTempFile("yugen-kanjidic-test", ".xml.gz")
        try {
            GZIPOutputStream(Files.newOutputStream(file)).use {
                it.write("""
                    <?xml version="1.0" encoding="UTF-8"?>
                    <!DOCTYPE kanjidic2 [<!ENTITY external SYSTEM "file:///not-a-yugen-dictionary">]>
                    <kanjidic2><character><literal>米</literal><reading_meaning><rmgroup>
                    <reading r_type="ja_on">ベイ</reading><reading r_type="ja_kun">こめ</reading>
                    <reading r_type="pinyin">mi3</reading><meaning>rice</meaning>
                    <meaning m_lang="en">USA</meaning><meaning m_lang="fr">riz</meaning>
                    <meaning>&external;</meaning></rmgroup></reading_meaning></character>
                    <character><literal>𠮷</literal><reading_meaning><rmgroup>
                    <meaning>good fortune</meaning></rmgroup></reading_meaning></character></kanjidic2>
                """.trimIndent().toByteArray(Charsets.UTF_8))
            }
            val details = KanjidicGlossary.load(file).lookup(listOf("米", "𠮷", "〇"))
            assertEquals(KanjiDetails("米", listOf("rice", "USA"), listOf("ベイ"), listOf("こめ")), details[0])
            assertEquals(listOf("good fortune"), details[1].meanings)
            assertEquals(KanjiDetails("〇"), details[2])
        } finally { Files.deleteIfExists(file) }
    }

}
