/**
 * L'anteprima di un Suono dalle casse del PC, non dagli Altoparlanti (§3.4).
 *
 * Serve in Setup, per riconoscere un file appena importato senza svegliare
 * tutta la casa -- e serve durante l'Evento per la stessa ragione, al
 * contrario: sentire com'e un Effetto prima di farlo partire nella stanza dove
 * ci sono i visitatori.
 *
 * Non passa dal thread audio: il thread audio parla solo con snapserver, e
 * mandare un Suono alle casse del PC da li vorrebbe dire aprire una seconda
 * uscita audio dentro il thread che non deve mai fermarsi. Si passa invece da
 * `System.Media.SoundPlayer` di .NET, che c'e su qualunque Windows: si scrive
 * un WAV temporaneo dal PCM gia decodificato in cache e lo si fa suonare.
 *
 * Una anteprima alla volta: la seconda ferma la prima. E cio che ci si aspetta
 * premendo due pulsanti di seguito.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BYTE_PER_CAMPIONE, type ImpostazioniAudio } from '../dominio/progetto.js'

/** Un'intestazione WAV canonica davanti al PCM che abbiamo gia. */
export function intestazioneWav(byteDati: number, a: ImpostazioniAudio): Buffer {
  const bytePerSecondo = a.frequenza * a.canali * BYTE_PER_CAMPIONE
  const t = Buffer.alloc(44)
  t.write('RIFF', 0)
  t.writeUInt32LE(36 + byteDati, 4)
  t.write('WAVE', 8)
  t.write('fmt ', 12)
  t.writeUInt32LE(16, 16)
  t.writeUInt16LE(1, 20) // PCM
  t.writeUInt16LE(a.canali, 22)
  t.writeUInt32LE(a.frequenza, 24)
  t.writeUInt32LE(bytePerSecondo, 28)
  t.writeUInt16LE(a.canali * BYTE_PER_CAMPIONE, 32)
  t.writeUInt16LE(8 * BYTE_PER_CAMPIONE, 34)
  t.write('data', 36)
  t.writeUInt32LE(byteDati, 40)
  return t
}

export class AnteprimaSuoni {
  private processo: ChildProcess | null = null
  private temporaneo: string | null = null

  /** `percorsoPcm` e il `.pcm` gia decodificato dalla libreria. */
  async suona(percorsoPcm: string, audio: ImpostazioniAudio): Promise<void> {
    await this.ferma()

    const pcm = await fs.readFile(percorsoPcm)
    const wav = path.join(os.tmpdir(), `regia-anteprima-${process.pid}.wav`)
    await fs.writeFile(wav, Buffer.concat([intestazioneWav(pcm.byteLength, audio), pcm]))
    this.temporaneo = wav

    // `PlaySync` blocca il processo di PowerShell finche il suono non e finito:
    // e cio che rende `ferma()` possibile. Con `Play()` il processo uscirebbe
    // subito e porterebbe via l'audio con se.
    this.processo = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = New-Object Media.SoundPlayer '${wav.replace(/'/g, "''")}'; $p.PlaySync()`,
      ],
      { windowsHide: true, stdio: 'ignore' },
    )
    this.processo.on('exit', () => {
      this.processo = null
      void this.pulisci()
    })
  }

  async ferma(): Promise<void> {
    const p = this.processo
    this.processo = null
    if (p) p.kill()
    await this.pulisci()
  }

  private async pulisci(): Promise<void> {
    const t = this.temporaneo
    this.temporaneo = null
    if (!t) return
    await fs.rm(t, { force: true }).catch(() => {})
  }
}
