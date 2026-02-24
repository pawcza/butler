export default {
  content: [
    './components/**/*.{js,vue,ts}',
    './layouts/**/*.vue',
    './pages/**/*.vue',
    './app.vue',
  ],
  theme: {
    extend: {
      colors: {
        ap: {
          bg: '#0a0a0a',
          panel: '#111111',
          border: '#222222',
          muted: '#444444',
          orange: '#ff6600',
          blue: '#33aaff',
          red: '#ff3333',
        },
      },
    },
  },
}
