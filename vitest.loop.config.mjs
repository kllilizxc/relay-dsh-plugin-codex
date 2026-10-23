export default {
  root: import.meta.dirname,
  cacheDir: './.vitest-loop-cache',
  esbuild: { jsx: 'automatic' },
  test: { environment: 'jsdom' },
}
