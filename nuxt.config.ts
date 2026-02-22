export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: ['@nuxtjs/tailwindcss'],
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
