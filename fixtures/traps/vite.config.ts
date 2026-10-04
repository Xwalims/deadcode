// A config file: nothing imports it, but it is loaded by Vite.
import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
});
