import { Alert } from 'react-native';
import type { EntryDeletion } from './store';

/**
 * Confirms deleting one knowledge entry. With a practice card, the user chooses to delete it too or keep it as an
 * independent card holding the entry's current answer; the photo and other entries always remain.
 */
export function confirmEntryDeletion(kind: 'word' | 'sentence', hasPracticeCard: boolean, onDelete: (options: EntryDeletion) => void): void {
  const noun = kind === 'word' ? 'word' : 'text';
  const remains = kind === 'word' ? 'Its text, photo and other words remain.' : 'Its photo and the words in Vocabulary remain.';
  if (!hasPracticeCard) {
    Alert.alert(`Delete this ${noun}?`, `Only this ${noun} is deleted. ${remains}`, [
      { text: 'Cancel', style: 'cancel' },
      { text: `Delete ${noun}`, style: 'destructive', onPress: () => onDelete({}) },
    ]);
    return;
  }
  Alert.alert(`Delete this ${noun}?`, `${remains} It also has a practice card: delete it too, or keep it as an independent card with the current answer.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: `Delete ${noun} and practice card`, style: 'destructive', onPress: () => onDelete({ keepPracticeCards: false }) },
    { text: `Delete ${noun}, keep practice card`, onPress: () => onDelete({ keepPracticeCards: true }) },
  ]);
}
