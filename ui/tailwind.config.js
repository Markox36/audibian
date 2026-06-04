export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'daw-bg0': '#0f0f0f',
        'daw-bg1': '#181818',
        'daw-bg2': '#222222',
        'daw-bg3': '#2c2c2c',
        'daw-bg4': '#383838',
        'daw-accent': '#ff7300',
        'daw-green': '#5dc122',
        'daw-blue': '#4a9eff',
        'daw-red': '#e05252',
        'daw-yellow': '#f0c040',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
}
