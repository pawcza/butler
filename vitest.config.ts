import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: { LLM_MODEL: 'test-model' },
  },
  resolve: {
    alias: {
      '~': resolve(__dirname, '.'),
    },
  },
})
