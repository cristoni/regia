/**
 * Questi test lanciano ffmpeg per davvero. Non e un test di unita puro, ed e
 * voluto: il pezzo che deve funzionare e proprio l'interfaccia con ffmpeg, e
 * simularla proverebbe soltanto che il simulatore e d'accordo con se stesso.
 *
 * Si collauda `assicura`, perche e la strada che il prodotto percorre: i
 * campioni li legge il thread audio dal `.pcm`, e qui si fa lo stesso --
 * leggere il file dal percorso restituito e l'unico modo onesto di verificare
 * cosa il thread audio trovera.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { progettoVuoto, type ImpostazioniAudio, type Suono } from '../dominio/progetto.js'
import { ErroreDecodifica, LibreriaSuoni } from './libreria.js'

const AUDIO: ImpostazioniAudio = progettoVuoto('x').audio
const cartelle: string[] = []
let disponibileFfmpeg = false

before(() => {
  disponibileFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0
})
after(async () => {
  for (const d of cartelle) await fs.rm(d, { recursive: true, force: true })
})

async function ambiente() {
  const radice = await fs.mkdtemp(path.join(os.tmpdir(), 'regia-suoni-'))
  cartelle.push(radice)
  const suoni = path.join(radice, 'suoni')
  const cache = path.join(radice, 'cache')
  await fs.mkdir(suoni, { recursive: true })
  return { radice, suoni, cache, libreria: new LibreriaSuoni(suoni, cache) }
}

/** Genera un vero file audio con ffmpeg: un tono di durata nota. */
function generaTono(destinazione: string, secondi: number, hz = 440): void {
  const esito = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
     '-i', `sine=frequency=${hz}:duration=${secondi}`, '-y', destinazione],
    { windowsHide: true },
  )
  assert.equal(esito.status, 0, `ffmpeg non ha generato il tono: ${esito.stderr}`)
}

function suonoDiProva(file: string): Suono {
  return {
    id: 's1', nome: 'Urlo', file, colore: '#cc0000', categoria: 'urlo',
    guadagno: 1, durataMs: null, tastoRapido: null, ordine: 0,
  }
}

/** I campioni come li leggera il thread audio: dal file, come Int16 little endian. */
async function campioniDi(percorso: string): Promise<Int16Array> {
  const dati = await fs.readFile(percorso)
  return new Int16Array(dati.buffer.slice(dati.byteOffset, dati.byteOffset + dati.byteLength))
}

describe('libreria dei Suoni', { skip: !disponibileFfmpeg && 'ffmpeg non disponibile' }, () => {
  it('decodifica nel formato del progetto e misura la durata vera', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    generaTono(path.join(a.suoni, 'tono.wav'), 2)

    const esito = await a.libreria.assicura(suonoDiProva('tono.wav'), AUDIO)
    assert.equal(esito.convertito, true)
    // Due secondi a 44100 Hz, con la tolleranza di un blocco di codifica.
    assert.ok(Math.abs(esito.durataMs - 2000) < 60, `durata misurata: ${esito.durataMs} ms`)

    const campioni = await campioniDi(esito.percorso)
    const attesi = Math.round((esito.durataMs / 1000) * AUDIO.frequenza) * AUDIO.canali
    assert.equal(campioni.length, attesi, 'la durata dichiarata e i byte sul disco devono coincidere')
    assert.ok(campioni.some((x) => x !== 0), 'il PCM decodificato e tutto zeri')
  })

  it('la seconda volta non riconverte', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    generaTono(path.join(a.suoni, 'tono.wav'), 1)
    const suono = suonoDiProva('tono.wav')

    assert.equal((await a.libreria.assicura(suono, AUDIO)).convertito, true)
    assert.equal((await a.libreria.assicura(suono, AUDIO)).convertito, false)
  })

  it('cambiare formato audio invalida la cache da solo', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    generaTono(path.join(a.suoni, 'tono.wav'), 1)
    const suono = suonoDiProva('tono.wav')

    const stereo = await a.libreria.assicura(suono, AUDIO)
    const mono = await a.libreria.assicura(suono, { ...AUDIO, canali: 1 })

    assert.equal(mono.convertito, true, 'passando a mono doveva riconvertire')
    const campioniStereo = await campioniDi(stereo.percorso)
    const campioniMono = await campioniDi(mono.percorso)
    assert.equal(campioniMono.length, campioniStereo.length / 2)
    // Stessa durata in secondi, meta campioni: e proprio cosi che mono dimezza la banda.
    assert.ok(Math.abs(mono.durataMs - stereo.durataMs) < 5)
  })

  it('spiega perche un file non si decodifica, invece di esplodere', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    await fs.writeFile(path.join(a.suoni, 'rotto.mp3'), 'non sono un mp3')

    await assert.rejects(
      () => a.libreria.assicura(suonoDiProva('rotto.mp3'), AUDIO),
      (e: unknown) => e instanceof ErroreDecodifica && /rotto\.mp3/.test(e.message),
    )
  })

  it('non lascia in cache un file troncato quando la conversione fallisce', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    await fs.writeFile(path.join(a.suoni, 'rotto.wav'), 'spazzatura')
    await assert.rejects(() => a.libreria.assicura(suonoDiProva('rotto.wav'), AUDIO))

    const inCache = await fs.readdir(a.cache).catch(() => [])
    assert.deepEqual(inCache, [], `residui in cache: ${inCache.join(', ')}`)
  })

  it('un Suono rotto non impedisce di caricare gli altri', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    generaTono(path.join(a.suoni, 'buono.wav'), 1)
    await fs.writeFile(path.join(a.suoni, 'rotto.wav'), 'spazzatura')

    const esito = await a.libreria.assicuraTutti(
      [
        { ...suonoDiProva('rotto.wav'), id: 's-rotto' },
        { ...suonoDiProva('buono.wav'), id: 's-buono' },
      ],
      AUDIO,
    )

    assert.equal(esito.pronti.length, 1)
    assert.equal(esito.pronti[0]!.suono.id, 's-buono')
    assert.ok(esito.pronti[0]!.percorso.endsWith('.pcm'))
    assert.equal(esito.errori.length, 1)
  })

  it('importando due file omonimi ma diversi non ne perde uno', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    const esterna = path.join(a.radice, 'esterna')
    await fs.mkdir(path.join(esterna, 'primo'), { recursive: true })
    await fs.mkdir(path.join(esterna, 'secondo'), { recursive: true })
    generaTono(path.join(esterna, 'primo', 'urlo.wav'), 1, 300)
    generaTono(path.join(esterna, 'secondo', 'urlo.wav'), 1, 900)

    const a1 = await a.libreria.importa(path.join(esterna, 'primo', 'urlo.wav'))
    const a2 = await a.libreria.importa(path.join(esterna, 'secondo', 'urlo.wav'))

    assert.notEqual(a1, a2, 'due suoni diversi non devono finire nello stesso file')
    assert.equal((await fs.readdir(a.suoni)).length, 2)
  })

  it('importando due volte lo stesso file non lo duplica', async (t) => {
    if (!disponibileFfmpeg) return t.skip('ffmpeg non disponibile')
    const a = await ambiente()
    const esterno = path.join(a.radice, 'urlo.wav')
    generaTono(esterno, 1)

    assert.equal(await a.libreria.importa(esterno), await a.libreria.importa(esterno))
    assert.equal((await fs.readdir(a.suoni)).length, 1)
  })
})
