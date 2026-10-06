import { createTheme } from '@mantine/core';

const emerald = [
  '#e1fff8', '#b3ffeb', '#80ffe0', '#4dffda', '#19f2c7',
  '#00d7ad', '#00b58f', '#008f72', '#006c56', '#004a3a',
] as const;

export const highstackTheme = createTheme({
  primaryColor: 'emerald',
  colors: { emerald },
  defaultRadius: 'md',
  radius: { xs: '0.35rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem' },
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  headings: {
    fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeight: '650',
    textWrap: 'balance',
    sizes: {
      h1: { fontSize: '2.5rem', lineHeight: '1.08', fontWeight: '700' },
      h2: { fontSize: '2rem', lineHeight: '1.15', fontWeight: '700' },
      h3: { fontSize: '1.5rem', lineHeight: '1.2', fontWeight: '650' },
      h4: { fontSize: '1.125rem', lineHeight: '1.3', fontWeight: '650' },
      h5: { fontSize: '1rem', lineHeight: '1.35', fontWeight: '650' },
      h6: { fontSize: '0.875rem', lineHeight: '1.4', fontWeight: '650' },
    },
  },
  spacing: { xs: '0.5rem', sm: '0.75rem', md: '1rem', lg: '1.5rem', xl: '2rem' },
  shadows: {
    xs: '0 2px 8px rgb(0 0 0 / 18%)',
    sm: '0 8px 24px rgb(0 0 0 / 24%)',
    md: '0 18px 48px rgb(0 0 0 / 32%)',
    lg: '0 24px 72px rgb(0 0 0 / 38%)',
    xl: '0 32px 96px rgb(0 0 0 / 44%)',
  },
  respectReducedMotion: true,
  cursorType: 'pointer',
});
