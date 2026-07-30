import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

/**
 * Runtime dependencies the Vite bundle deliberately does NOT bundle, and which
 * therefore have to be copied into the packaged app by hand.
 *
 * `node-pty` is a native module, so `vite.main.config.ts` marks it external and
 * the bundle `require()`s it at runtime. The Vite plugin ships only the bundle —
 * it copies no `node_modules` — so without this the packaged app throws
 * "Cannot find module 'node-pty'" the first time it opens a session. Nothing in
 * dev or in the E2E suite catches that: both run from the source tree, where
 * `node_modules` is present.
 *
 * `node-addon-api` is node-pty's own runtime dependency.
 */
const EXTERNAL_RUNTIME_DEPS = ['node-pty', 'node-addon-api'];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      for (const dep of EXTERNAL_RUNTIME_DEPS) {
        const from = path.join(process.cwd(), 'node_modules', dep);
        const to = path.join(buildPath, 'node_modules', dep);
        await mkdir(path.dirname(to), { recursive: true });
        // `prebuilds/` carries binaries for every platform node-pty supports;
        // this app is macOS-only, so they are dead weight in the bundle.
        await cp(from, to, {
          recursive: true,
          filter: (source) => !source.includes(`${path.sep}prebuilds${path.sep}`),
        });
      }
    },
  },
  // macOS only — no Windows (Squirrel) or Linux (deb/rpm) makers.
  makers: [new MakerZIP({}, ['darwin'])],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          // Keyed as an object (rather than a bare path) so the output chunk is named
          // `main` — a bare 'src/main/index.ts' string would produce `.vite/build/index.js`,
          // which doesn't match package.json's "main" field.
          entry: { main: 'src/main/index.ts' },
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          // Keyed as `preload` so the output is `.vite/build/preload.js`, matching the
          // `preload: path.join(__dirname, 'preload.js')` reference in src/main/index.ts.
          entry: { preload: 'src/preload/index.ts' },
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          // .mts (not .ts): this config imports the ESM-only @vitejs/plugin-react.
          // A .mts extension forces Node to load it as ESM regardless of the
          // package's "type" field, so plugin-react resolves without needing
          // "type": "module" at the root — which would otherwise make Electron
          // misread the Vite plugin's CommonJS main/preload build output as ESM.
          // See https://vite.dev/guide/troubleshooting.html#this-package-is-esm-only
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
