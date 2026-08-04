import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{shared,daemon,extension}/src/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
