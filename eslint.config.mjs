import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  { settings: { next: { rootDir: 'apps/web/' } } },
  globalIgnores(['**/.next/**', '**/next-env.d.ts', 'work/**', 'outputs/**', 'test-results/**', '.malha/**', 'dist/**', 'apps/site-static/**', 'video/dist/**', 'video/out/**']),
]);
