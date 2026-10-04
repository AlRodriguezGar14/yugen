import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { styles } from './uiStyles';

/** A polite live status line that fades in when its text changes; no motion when Reduce Motion is on. */
export default function StatusMessage({ text, error = false }: { text: string | null; error?: boolean }) {
  const [opacity] = useState(() => new Animated.Value(1));
  const [reduceMotion, setReduceMotion] = useState(true);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => { if (active) setReduceMotion(enabled); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  useEffect(() => {
    if (!text || reduceMotion) {
      opacity.stopAnimation();
      opacity.setValue(1);
      return undefined;
    }
    opacity.setValue(0);
    const fade = Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true });
    fade.start();
    // A newer message or unmount stops this fade and leaves the text fully visible.
    return () => { fade.stop(); opacity.setValue(1); };
  }, [text, reduceMotion, opacity]);

  if (!text) return null;
  return (
    <Animated.Text accessibilityLiveRegion={error ? 'assertive' : 'polite'} accessibilityRole={error ? 'alert' : 'text'}
      style={[error ? styles.errorMessage : styles.noticeMessage, { opacity }]}>
      {text}
    </Animated.Text>
  );
}
