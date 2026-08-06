import { execFile } from 'node:child_process';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';

const execFileAsync = promisify(execFile);

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

/**
 * Ad-hoc re-signs a packaged .app bundle, nested code first, so that
 * `codesign --verify --deep --strict` passes on the result. See the
 * `postPackage` hook below for why this has to run, and why it has to run
 * there specifically.
 *
 * This app has no Apple Developer Program membership, so this is an ad-hoc
 * signature (`--sign -`): it proves the bundle hasn't been tampered with
 * since packaging, not who built it. That's enough for Gatekeeper to offer
 * "Open Anyway" instead of refusing outright with no path forward.
 *
 * Nested code (the four Electron helper apps and five frameworks under
 * Contents/Frameworks, confirmed by inspecting a packaged build) is signed
 * individually before the outer bundle, rather than via `codesign --deep`
 * on the outer bundle alone. Apple's own codesign documentation deprecates
 * `--deep` for signing (as opposed to verifying): it walks the bundle by
 * convention rather than by manifest, and can sign nested code in the wrong
 * order or skip it in unusual layouts. Electron's layout here nests only
 * one level deep (no framework or helper app embeds further nested code),
 * so signing that level and then the outer bundle covers every Mach-O
 * binary with the same result --deep would give, without relying on
 * --deep's own bundle-walking to get it right. Verified both ways: a full
 * `codesign --sign - --force --deep` re-sign at this same point in the
 * hook also passes `--verify --deep --strict`, but the inside-out form is
 * the one Apple recommends, so that's what ships.
 */
async function adHocSign(appPath: string): Promise<void> {
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  let nestedCode: string[] = [];
  try {
    nestedCode = await readdir(frameworksDir);
  } catch {
    // No Frameworks directory: nothing nested to sign ahead of the app itself.
  }
  for (const entry of nestedCode) {
    if (entry.endsWith('.framework') || entry.endsWith('.app')) {
      await execFileAsync('codesign', ['--sign', '-', '--force', path.join(frameworksDir, entry)]);
    }
  }
  await execFileAsync('codesign', ['--sign', '-', '--force', appPath]);
}

const config: ForgeConfig = {
  packagerConfig: {
    /**
     * `AutoUnpackNativesPlugin` (below) keeps this glob and ORs its own onto
     * it, and its own only ever matches files ending in `.node`. node-pty
     * needs one more file outside the asar: `spawn-helper`, an extensionless
     * Mach-O it executes for every pty. `lib/unixTerminal.js` resolves that
     * helper next to whichever native module it loaded (`build/Release`
     * here) and then rewrites `app.asar` to `app.asar.unpacked` in the
     * resulting path. So a `spawn-helper` left inside the archive leaves
     * that path pointing at a file that does not exist, and every session in
     * the packaged app dies at `posix_spawnp failed.` before a shell starts.
     * Nothing upstream of the packaged app catches it: dev and the E2E suite
     * load node-pty straight out of `node_modules`, where the helper is an
     * ordinary executable file on disk.
     */
    asar: { unpack: '**/node_modules/node-pty/build/Release/spawn-helper' },
    /**
     * Extensionless by design: Electron Packager appends the extension each
     * platform wants, `.icns` here. `src/images/icon.icns` is generated from
     * `icon.jpg` with `sips` and `iconutil`, and both are committed so a
     * packaged build needs no image tooling.
     *
     * Only the packaged app reads this. `electron-forge start` shows the
     * default Electron icon in the dock, which is a dev-only cosmetic.
     */
    icon: 'src/images/icon',
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
    /**
     * Re-signs the packaged app after everything else has touched it.
     *
     * `FusesPlugin` below flips the security fuses baked into the Electron
     * binary, and (on darwin/arm64, with no `osxSign` config, which is this
     * app's case) also ad-hoc re-signs the bundle for exactly the reason
     * this hook exists: flipping fuses rewrites the Electron binary, which
     * invalidates Packager's own initial ad-hoc signature. But that re-sign
     * runs inside the `packageAfterCopy` hook phase, and packaging keeps
     * modifying the bundle after that phase ends: `asar: true` below packs
     * `Contents/Resources/app.asar`, and `AutoUnpackNativesPlugin` then
     * pulls `node-pty` back out into `app.asar.unpacked`. Both run after
     * `packageAfterCopy`, so both invalidate the fuses plugin's re-sign too.
     * The result, confirmed with `codesign --verify --deep --strict` on a
     * real `npm run package` output: an adhoc signature that fails
     * verification with "invalid Info.plist (plist or signature have been
     * modified)". That failure is invisible in local dev or in this repo's
     * E2E suite, because Gatekeeper only enforces a signature on a file
     * carrying the quarantine attribute (set when a file arrives via
     * download, not when it's built locally). A user who downloads the
     * zipped app gets "PRCLI.app is damaged and can't be opened", with no
     * "Open Anyway" fallback.
     *
     * `postPackage` is the only hook that fires after electron-packager's
     * `packager()` promise has resolved, i.e. after every packaging step
     * (copy, prune, asar, fuses) is done, confirmed by instrumenting this
     * hook and inspecting `packageResult` on a real package run. That makes
     * it the only hook where a re-sign here actually survives to the built
     * output, rather than being invalidated by a later packaging step the
     * way the fuses plugin's own re-sign is.
     */
    postPackage: async (_forgeConfig, packageResult) => {
      if (packageResult.platform !== 'darwin') {
        return;
      }
      for (const outputPath of packageResult.outputPaths) {
        const entries = await readdir(outputPath);
        for (const entry of entries) {
          if (entry.endsWith('.app')) {
            await adHocSign(path.join(outputPath, entry));
          }
        }
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
