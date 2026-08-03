import { readFileSync } from 'node:fs'
import { cwd } from 'node:process'
import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), 'STUDYCORD_')
  const certificatePath = env.STUDYCORD_HTTPS_CERT_FILE
  const certificateKeyPath = env.STUDYCORD_HTTPS_KEY_FILE

  if (Boolean(certificatePath) !== Boolean(certificateKeyPath)) {
    throw new Error(
      'Set both STUDYCORD_HTTPS_CERT_FILE and STUDYCORD_HTTPS_KEY_FILE, or neither.'
    )
  }

  const https = certificatePath
    ? {
        cert: readFileSync(resolve(cwd(), certificatePath)),
        key: readFileSync(resolve(cwd(), certificateKeyPath)),
      }
    : undefined

  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] })
    ],
    server: {
      https,
      proxy: {
        '/api': {
          target: env.STUDYCORD_BACKEND_PROXY_TARGET || 'http://127.0.0.1:8000',
          changeOrigin: true,
        },
      },
    },
  }
})
