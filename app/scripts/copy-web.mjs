// Copies the static site (Blending Station + TankLabel) into www/, the Capacitor
// webDir. The site itself stays build-free: GitHub Pages keeps serving the
// repository root as is, and the app bundles a snapshot of the same files.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const siteDir = join(appDir, '..')
const webDir = join(appDir, 'www')

const SITE_ENTRIES = [
  'index.html',
  'manifest.json',
  'service-worker.js',
  'native-app.js',
  'icon-192.png',
  'icon-512.png',
  'assets',
  'tanklabel',
]

rmSync(webDir, { recursive: true, force: true })
mkdirSync(webDir)
for (const entry of SITE_ENTRIES) {
  cpSync(join(siteDir, entry), join(webDir, entry), { recursive: true })
}
console.log(`Copied ${SITE_ENTRIES.length} site entries into ${webDir}`)
