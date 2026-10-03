export const colors = {
  paper: '#FFFFFF',
  ink: '#161616',
  muted: '#525252',
  line: '#D5D5D5',
  card: '#FFFFFF',
  green: '#161616',
  greenWash: '#EFEFEF',
  orange: '#8B3228',
  white: '#FFFFFF',
};

export function tabBarStyle(bottomInset: number) {
  // Custom icon/label sizes need more than UIKit's default 49pt, plus the home indicator.
  return { backgroundColor: colors.card, borderTopColor: colors.ink, borderTopWidth: 2, height: 64 + bottomInset };
}
