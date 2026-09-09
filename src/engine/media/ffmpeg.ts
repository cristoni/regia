/**
 * Dove sta ffmpeg, e perche non basta scrivere "ffmpeg".
 *
 * ⚠️ L'`ffmpeg` in PATH su questa macchina **non e il binario vero**: e uno shim
 * Chocolatey da 26 KB che lancia il vero ffmpeg come processo figlio.
 * `child.kill()` uccide lo shim e lascia il vero ffmpeg **orfano** -- cioe una
 * registrazione che continua a scrivere su un file che Regia crede chiuso, e un
 * telefono che resta occupato dalla sua unica connessione consentita.
 *
 * Quindi: si cerca prima il binario in bundle. Il PATH e un ripiego, e si dice
 * a voce alta che lo e.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface FfmpegTrovato {
  readonly percorso: string
  readonly versione: string
  /** Vero se e il binario in bundle. Falso: e quello del PATH, con i suoi rischi. */
  readonly inBundle: boolean
}

const qui = path.dirname(fileURLToPath(import.meta.url))

/** `src/engine/media` -> radice del progetto; `dist/engine/media` -> idem. */
function radiciCandidate(): string[] {
  return [
    path.resolve(qui, '../../..'),
    path.resolve(qui, '../../../..'),
    process.cwd(),
    // Impacchettato con Electron: le risorse stanno accanto all'eseguibile.
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), 'resources'),
  ]
}

function candidati(): string[] {
  const nome = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dalAmbiente = process.env['REGIA_FFMPEG']
  return [
    ...(dalAmbiente ? [dalAmbiente] : []),
    ...radiciCandidate().map((r) => path.join(r, 'vendor', 'ffmpeg', nome)),
  ]
}

let memoria: FfmpegTrovato | null | undefined

export function trovaFfmpeg(riesamina = false): FfmpegTrovato | null {
  if (!riesamina && memoria !== undefined) return memoria

  for (const percorso of candidati()) {
    if (!fs.existsSync(percorso)) continue
    const v = versioneDi(percorso)
    if (v) return (memoria = { percorso, versione: v, inBundle: true })
  }

  const v = versioneDi('ffmpeg')
  memoria = v ? { percorso: 'ffmpeg', versione: v, inBundle: false } : null
  return memoria
}

function versioneDi(percorso: string): string | null {
  const r = spawnSync(percorso, ['-version'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (r.status !== 0 || !r.stdout) return null
  return (r.stdout.split(/\r?\n/)[0] ?? '').replace(/^ffmpeg version /, '').trim() || null
}
