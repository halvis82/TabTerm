import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,daemon,extension}/src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // Integration tests drive real PTYs and real sockets, which is slower than unit work.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
