export default defineNuxtConfig({
  devServer: { port: 3001 },
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss', '@tresjs/nuxt'],
  experimental: { appManifest: false },
  app: {
    head: {
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      ],
    },
  },
  typescript: {
    strict: true,
    tsConfig: {
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noPropertyAccessFromIndexSignature: true,
      },
    },
  },
  nitro: {
    experimental: { websocket: true },
  },
  vite: {
    optimizeDeps: {
      include: ['@ricky0123/vad-web', 'onnxruntime-web'],
    },
  },
})
