import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export default function SourcesScreen() {
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <View style={styles.topBar}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>‹ Library</Text>
        </Pressable>
        <Text style={styles.topTitle}>SOURCES</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>YUGEN · ABOUT</Text>
        <Text style={styles.title}>Built from local tools and shared language data.</Text>
        <Text style={styles.intro}>Photos and raw OCR stay on your phone. Readings and character definitions use your local dictionary service. AI translation is disabled.</Text>

        <View style={styles.entry}>
          <Text style={styles.entryTitle}>JMdict</Text>
          <Text style={styles.entryCopy}>Dictionary glosses use JMdict. Copyright belongs to the Electronic Dictionary Research and Development Group (EDRDG). Used under the Creative Commons Attribution-ShareAlike 4.0 International license.</Text>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://www.edrdg.org/edrdg/licence.html')}>
            <Text style={styles.link}>EDRDG license and attribution</Text>
          </Pressable>
        </View>

        <View style={styles.entry}>
          <Text style={styles.entryTitle}>KANJIDIC2</Text>
          <Text style={styles.entryCopy}>Character meanings and standard on/kun readings use KANJIDIC2, copyright the Electronic Dictionary Research and Development Group (EDRDG), under its Creative Commons Attribution-ShareAlike license.</Text>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://www.edrdg.org/wiki/KANJIDIC_Project.html')}><Text style={styles.link}>KANJIDIC project</Text></Pressable>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://www.edrdg.org/edrdg/licence.html')}><Text style={styles.link}>EDRDG license and attribution</Text></Pressable>
        </View>

        <View style={styles.entry}>
          <Text style={styles.entryTitle}>Yugen known-term guide</Text>
          <Text style={styles.entryCopy}>Selected readings and meanings are app-maintained. These are labeled separately from JMdict; they do not replace or modify your captured text.</Text>
        </View>

        <View style={styles.entry}>
          <Text style={styles.entryTitle}>Sudachi</Text>
          <Text style={styles.entryCopy}>Japanese word segmentation and readings use Sudachi, licensed under Apache License 2.0. Its dictionary is a separately licensed data resource.</Text>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL('https://github.com/WorksApplications/Sudachi')}>
            <Text style={styles.link}>Sudachi source and license</Text>
          </Pressable>
        </View>

        <View style={styles.entry}>
          <Text style={styles.entryTitle}>Google ML Kit</Text>
          <Text style={styles.entryCopy}>Japanese text recognition uses Google ML Kit on-device text-recognition models under Google’s applicable terms. OCR does not require an internet connection.</Text>
        </View>
        <Text style={styles.notice}>Dictionary files are downloaded for local development and are not committed to this repository. See DEVELOPMENT.md for data setup and updates.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  topBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 24, borderBottomWidth: 1, borderBottomColor: colors.line },
  backButton: { minWidth: 86, paddingVertical: 9 },
  backText: { color: colors.green, fontSize: 16, fontWeight: '700' },
  topTitle: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1.4 },
  content: { paddingHorizontal: 24, paddingTop: 23, paddingBottom: 28, maxWidth: 720, width: '100%', alignSelf: 'center' },
  eyebrow: { color: colors.muted, fontSize: 14, fontWeight: '700', letterSpacing: 1.3 },
  title: { color: colors.ink, fontSize: 24, lineHeight: 32, fontWeight: '700', marginTop: 10 },
  intro: { color: colors.muted, fontSize: 16, lineHeight: 21, marginTop: 9 },
  entry: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 12, padding: 16, marginTop: 14 },
  entryTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  entryCopy: { color: colors.muted, fontSize: 16, lineHeight: 21, marginTop: 6 },
  link: { color: colors.green, fontSize: 16, fontWeight: '700', marginTop: 10 },
  notice: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: 18 },
});
