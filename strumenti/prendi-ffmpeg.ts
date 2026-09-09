/**
 * Mette ffmpeg in `vendor/ffmpeg/`, da dove l'app impacchettata se lo porta via.
 *
 *   npm run ffmpeg:prendi
 *
 * Esiste perché il binario pesa 133 MB e non sta in git: senza questo script il
 * modo di rifare la build vivrebbe solo nella memoria di chi l'ha fatta la
 * prima volta, che è lo stesso motivo per cui esiste `banco/prepara.ts`.
 *
 * ⚠️ **Si prende la build LGPL, non la GPL, e non è indifferente.** Il §267 del
 * documento di progetto chiede di rispettare gli obblighi di licenza, e quelli
 * della LGPL si soddisfano spedendo la licenza accanto al binario -- che è
 * quello che fa `extraResources` in `electron-builder.yml`. Con una build GPL
 * l'obbligo si estenderebbe all'offerta scritta dei sorgenti.
 *
 * ⚠️ E si prende un binario **in bundle** invece di affidarsi al PATH per la
 * ragione scritta in cima a `src/engine/media/ffmpeg.ts`: l'`ffmpeg` del PATH su
 * una macchina qualsiasi può essere lo shim Chocolatey da 26 KB, e ucciderlo
 * lascia orfano il vero ffmpeg -- cioè una registrazione che continua a scrivere
 * su un file che Regia crede chiuso.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cartella = path.join(radice, 'vendor', 'ffmpeg')
const binario = path.join(cartella, 'ffmpeg.exe')

const NOME = 'ffmpeg-master-latest-win64-lgpl'
const URL_ZIP = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${NOME}.zip`

const gia = await fs
  .access(binario)
  .then(() => true)
  .catch(() => false)
if (gia) {
  console.log(`gia presente: ${binario}`)
  process.exit(0)
}

console.log(`scarico ${NOME}.zip (~170 MB)...`)
const risposta = await fetch(URL_ZIP)
if (!risposta.ok) throw new Error(`scaricamento fallito: HTTP ${risposta.status}`)

const temporanea = await fs.mkdtemp(path.join(radice, '.cache-ffmpeg-'))
try {
  const zip = path.join(temporanea, 'ffmpeg.zip')
  await fs.writeFile(zip, Buffer.from(await risposta.arrayBuffer()))

  console.log('estraggo...')
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path "${zip}" -DestinationPath "${temporanea}" -Force`],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (r.status !== 0) throw new Error(`estrazione fallita: ${r.stderr ?? ''}`)

  await fs.mkdir(cartella, { recursive: true })
  // La licenza viaggia col binario, non dopo: separarli è il modo in cui un
  // obbligo di licenza si perde per strada.
  await fs.copyFile(path.join(temporanea, NOME, 'bin', 'ffmpeg.exe'), binario)
  await fs.copyFile(path.join(temporanea, NOME, 'LICENSE.txt'), path.join(cartella, 'LICENSE.txt'))
} finally {
  await fs.rm(temporanea, { recursive: true, force: true })
}

const versione = spawnSync(binario, ['-version'], { encoding: 'utf8', windowsHide: true })
console.log(`\n${(versione.stdout ?? '').split(/\r?\n/)[0] ?? '?'}\n-> ${binario}`)
