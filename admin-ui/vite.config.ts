import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

const packageInfo = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  plugins: [vue()],
  define: {
    // 界面只显示一位小数：1.0 / 1.1 / 1.2 …
    __APP_VERSION__: JSON.stringify(String(packageInfo.version).replace(/^(\d+\.\d+).*$/, '$1')),
  },
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
