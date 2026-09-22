import { defineConfig } from 'vite'
import { resolve } from 'path'
import { copyFileSync, existsSync } from 'fs'

/** Vite plugin to copy rules.json from the library package into dist/ at build time. */
function copyRulesPlugin() {
  return {
    name: 'copy-rules-json',
    closeBundle() {
      // Resolve from the workspace-linked package (works for both workspace:* and npm installs)
      const src = resolve(__dirname, 'node_modules/ai-session-free/rules.json')
      const dest = resolve(__dirname, 'dist/rules.json')
      if (existsSync(src)) {
        copyFileSync(src, dest)
        console.log('✅ Copied rules.json from ai-session-free package → dist/')
      } else {
        console.warn('⚠  rules.json not found at', src)
      }
    },
  }
}

export default defineConfig({
  plugins: [copyRulesPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.js'),
        app: resolve(__dirname, 'app.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
})
