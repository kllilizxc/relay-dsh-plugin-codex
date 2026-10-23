import { fileURLToPath } from 'node:url'

const local = (path) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url))

export default {
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: local('react'),
      'react-dom': local('react-dom'),
    },
  },
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\//, /dsh-client/],
      },
    },
  },
}
