import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ImagePickerAsset } from 'expo-image-picker';
import { ActivityIndicator, AppState, Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';
import { colors } from '@/theme';

type PhotoJob = { status: 'idle' | 'capturing' | 'handing-off' } | { status: 'failed'; message: string };

/** A single shutter action hands the photo directly to the capture/OCR flow. */
export default function CameraCapture({ onPhoto, onClose }: {
  onPhoto: (takePhoto: () => Promise<ImagePickerAsset>) => Promise<void>;
  onClose: () => void;
}) {
  const device = useCameraDevice('back');
  const permission = useCameraPermission();
  const photoOutput = usePhotoOutput({ containerFormat: 'jpeg', quality: 1 });
  const outputs = useMemo(() => [photoOutput], [photoOutput]);
  const [focused, setFocused] = useState(false);
  const [appState, setAppState] = useState(AppState.currentState);
  const [preview, setPreview] = useState<'starting' | 'ready' | 'unavailable'>('starting');
  const [photo, setPhoto] = useState<PhotoJob>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const takingPhoto = useRef<object | null>(null);
  const mounted = useRef(true);
  const busy = photo.status === 'capturing' || photo.status === 'handing-off';
  const active = focused && appState === 'active' && permission.hasPermission && !!device;
  const canTakePhoto = active && preview === 'ready' && !busy;
  const eligibility = useRef(canTakePhoto);
  useLayoutEffect(() => { eligibility.current = canTakePhoto; }, [canTakePhoto]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; eligibility.current = false; };
  }, []);

  useFocusEffect(useCallback(() => {
    setFocused(true);
    return () => { eligibility.current = false; setFocused(false); setPreview('starting'); };
  }, []));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') { eligibility.current = false; setPreview('starting'); }
      setAppState(state);
    });
    return () => subscription.remove();
  }, []);

  const { canRequestPermission, requestPermission } = permission;
  useEffect(() => {
    let active = true;
    if (canRequestPermission) {
      void requestPermission().catch(() => {
        if (active) setError('Camera access could not be requested. You can choose a photo instead.');
      });
    }
    return () => { active = false; };
  }, [canRequestPermission, requestPermission]);

  async function takePhoto() {
    if (!eligibility.current || takingPhoto.current) return;
    const job = {};
    takingPhoto.current = job;
    eligibility.current = false;
    setPhoto({ status: 'capturing' });
    setError(null);
    try {
      // The parent owns the job before native capture starts, including deferred New/resume requests.
      await onPhoto(async () => {
        // Some operating systems enforce the shutter sound regardless of this request.
        const { filePath } = await photoOutput.capturePhotoToFile({ enableShutterSound: false }, {});
        const uri = `file://${filePath}`;
        const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          Image.getSize(uri, (width, height) => resolve({ width, height }), reject);
        });
        if (mounted.current && takingPhoto.current === job) setPhoto({ status: 'handing-off' });
        return { uri, ...dimensions, fileName: filePath.split('/').pop(), mimeType: 'image/jpeg', type: 'image' };
      });
      if (mounted.current && takingPhoto.current === job) setPhoto({ status: 'idle' });
    } catch {
      if (mounted.current && takingPhoto.current === job) {
        setPhoto({ status: 'failed', message: 'The photo could not be captured or saved. Try again, or choose a photo from your Library.' });
      }
    } finally {
      if (takingPhoto.current === job) takingPhoto.current = null;
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={onClose} style={styles.close}>
          <Text style={styles.closeText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Capture Japanese</Text>
      </View>
      <View style={styles.viewfinder}>
        {permission.hasPermission && device ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            outputs={outputs}
            isActive={active}
            enableNativeTapToFocusGesture
            enableNativeZoomGesture
            onPreviewStarted={() => { setPreview('ready'); setError(null); }}
            onPreviewStopped={() => { eligibility.current = false; setPreview('starting'); }}
            onStopped={() => { eligibility.current = false; setPreview('starting'); }}
            onInterruptionStarted={() => { eligibility.current = false; setPreview('starting'); }}
            onError={() => { eligibility.current = false; setPreview('unavailable'); setError('The camera is unavailable. Go back and choose a photo, or reopen the camera.'); }}
          />
        ) : (
          <View style={styles.permission}>
            <Text style={styles.permissionTitle}>{permission.hasPermission ? 'No camera available' : 'Allow camera access'}</Text>
            <Text style={styles.permissionCopy}>You can also go back and choose an existing photo.</Text>
            {!permission.hasPermission && !permission.canRequestPermission && (
              <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings().catch(() => setError('Open Settings to allow camera access.'))} style={styles.settings}>
                <Text style={styles.settingsText}>Open Settings</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
      <View style={styles.footer}>
        <Text style={styles.hint}>Point at the text. Tap once to read it.</Text>
        {error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {photo.status === 'failed' && <Text accessibilityLiveRegion="polite" style={styles.error}>{photo.message}</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Take photo and read Japanese text"
          accessibilityState={{ disabled: !canTakePhoto, busy }}
          disabled={!canTakePhoto}
          onPress={() => void takePhoto()}
          style={({ pressed }) => [styles.shutter, pressed && styles.pressed, !canTakePhoto && styles.disabled]}
        >
          {busy ? <ActivityIndicator color={colors.ink} /> : <View style={styles.shutterCenter} />}
        </Pressable>
        <Text style={styles.caption}>Text recognition stays on your phone.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ink },
  header: { minHeight: 64, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', gap: 16 },
  close: { minHeight: 44, minWidth: 64, justifyContent: 'center' },
  closeText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  title: { color: colors.white, fontSize: 20, fontWeight: '700' },
  viewfinder: { flex: 1, overflow: 'hidden', backgroundColor: '#242424' },
  permission: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center', gap: 16 },
  permissionTitle: { color: colors.white, fontSize: 24, fontWeight: '700' },
  permissionCopy: { color: '#E0E0E0', fontSize: 16, lineHeight: 24, textAlign: 'center' },
  settings: { minHeight: 48, paddingHorizontal: 24, justifyContent: 'center', borderRadius: 8, backgroundColor: colors.white },
  settingsText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  footer: { alignItems: 'center', padding: 24, gap: 16 },
  hint: { color: colors.white, fontSize: 16, lineHeight: 24 },
  error: { color: '#FFD6D0', fontSize: 14, lineHeight: 20, textAlign: 'center' },
  shutter: { width: 80, height: 80, borderRadius: 40, backgroundColor: colors.white, padding: 6, alignItems: 'center', justifyContent: 'center' },
  shutterCenter: { width: 64, height: 64, borderRadius: 32, borderWidth: 3, borderColor: colors.ink },
  caption: { color: '#D0D0D0', fontSize: 14 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
});
