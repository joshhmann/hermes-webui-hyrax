import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test'

  return {
    resolve: {
      alias: isTest ? [
        { find: /^three(?:\/.*)?$/, replacement: path.resolve(__dirname, 'tests/fakes/three.js') },
        { find: /^@pixiv\/three-vrm/, replacement: path.resolve(__dirname, 'tests/fakes/vrm.js') },
      ] : undefined,
    },
    build: {
      cssCodeSplit: false,
      lib: {
        entry: './src/index.ts',
        formats: ['es'],
        fileName: () => isTest ? 'embodiment-bundle-test.js' : 'embodiment-bundle.js',
      },
      minify: 'esbuild',
      outDir: isTest ? 'test-output' : '../static/hyrax/3d',
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) =>
            assetInfo.name?.endsWith('.css') ? 'embodiment-bundle.css' : '[name][extname]',
          inlineDynamicImports: true,
        },
      },
      sourcemap: false,
    },
  }
})
