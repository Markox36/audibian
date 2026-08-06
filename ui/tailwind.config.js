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
          panel:  '#101013',
          strip:  'rgba(255, 255, 255, 0.055)',
          faint:  'rgba(255, 255, 255, 0.14)',
          rail:   'rgba(255, 255, 255, 0.58)',
          cream:  '#eceade',
          green:  '#45d99a',
          'green-dim': 'rgba(69, 217, 154, 0.35)',
          red:    '#ff6b6e',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
