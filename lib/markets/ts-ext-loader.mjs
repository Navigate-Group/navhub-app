/**
 * Tiny ESM resolve hook for the Markets fixture tests.
 * ──────────────────────────────────────────────────────────────────────────
 * The Markets library modules use extension-less relative imports (e.g.
 * `from './compute'`), which webpack/Next resolve at build time but Node's
 * native ESM resolver does not. This loader lets the compute/explorer fixture
 * tests run under `node --test --experimental-strip-types` by retrying an
 * unresolved relative specifier with a `.ts` extension. It is test-only and is
 * never bundled into the app.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as pathResolve } from 'node:path'

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[cm]?[jt]s$/.test(specifier) &&
      context.parentURL
    ) {
      const parentDir = dirname(fileURLToPath(context.parentURL))
      const candidate = pathResolve(parentDir, `${specifier}.ts`)
      if (existsSync(candidate)) {
        // Re-resolve the `.ts` specifier through the default chain so Node's
        // --experimental-strip-types still strips the TypeScript syntax.
        return nextResolve(`${specifier}.ts`, context)
      }
    }
    throw err
  }
}
