import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <View style={styles.mark}>
        <Text style={styles.markText}>幽</Text>
      </View>
      <Text style={styles.title}>Yugen</Text>
      <Text style={styles.subtitle}>Learn from the world around you.</Text>
      <Text style={styles.status}>Development shell ready</Text>
      <StatusBar style="dark" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F7F4EE',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  mark: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#1E2A24',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  markText: {
    color: '#F7F4EE',
    fontSize: 36,
  },
  title: {
    color: '#1E2A24',
    fontSize: 38,
    fontWeight: '700',
    letterSpacing: 1,
  },
  subtitle: {
    color: '#59645E',
    fontSize: 16,
    marginTop: 12,
    textAlign: 'center',
  },
  status: {
    color: '#8A918C',
    fontSize: 13,
    marginTop: 48,
  },
});
