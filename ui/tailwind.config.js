export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Mixer palette. Kept in sync with ui/src/components/mixer/theme.js,
      // which exports the same values for the places that need them inside an
      // interpolated inline style (meter fills, per-strip accents).
      //
      // The previous `daw-*` palette (orange #ff7300, green #5dc122) was left
      // behind by an older design and matched nothing in the app.
      colors: {
        mix: {
          panel:  '#0a0a0a',
          strip:  'rgba(255, 255, 255, 0.02)',
          faint:  'rgba(255, 255, 255, 0.06)',
          rail:   'rgba(255, 255, 255, 0.4)',
          cream:  '#e8e6dd',
          green:  '#3ecf8e',
          'green-dim': 'rgba(62, 207, 142, 0.35)',
          red:    '#ff5e62',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
