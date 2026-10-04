import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, tabBarStyle } from '@/theme';

export default function TabLayout() {
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green,
        tabBarInactiveTintColor: colors.muted,
        tabBarHideOnKeyboard: true,
        tabBarLabelPosition: 'below-icon',
        tabBarLabelStyle: { fontSize: 12, lineHeight: 16, fontWeight: '700' },
        tabBarStyle: tabBarStyle(insets.bottom),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          tabBarLabel: 'Library',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22, lineHeight: 28 }}>文</Text>,
        }}
      />
      <Tabs.Screen
        name="capture"
        options={{
          title: 'New capture',
          tabBarLabel: 'Capture',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 24, lineHeight: 28, fontWeight: '900' }}>＋</Text>,
        }}
      />
      <Tabs.Screen
        name="review"
        options={{
          title: 'OCR Review',
          tabBarLabel: 'Drafts',
          tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 22, lineHeight: 28 }}>文</Text>,
        }}
      />
    </Tabs>
  );
}
