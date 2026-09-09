/**
 * Misura l'anticipo di scrittura contro un snapserver vero.
 *
 *   npx tsx banco/scrivi-dal-vero.ts [secondiPerValore] [anticipi...]
 *   npx tsx banco/scrivi-dal-vero.ts 60 50 100 200 400 1000
 *
 * E l'esperimento che l'[ADR 0007] lascia aperto, e che decide un criterio di
 * accettazione: `latenzaAttesaMs()` vale `buffer + anticipo`, e il §8.3
 * riscritto punta a quella funzione. Finche l'anticipo e un numero scelto a
 * intuito, il criterio e disonesto.
 *
 * Cosa si guarda, e non e ovvio: **non il numero di risincronizzazioni, ma la
 * loro grandezza**. Lo snapclient fa una risincronizzazione dura solo sopra
 * 500 ms di scarto; sotto corregge dolcemente e nessuno se ne accorge.
 *
 * Presuppone: banco preparato (`npx tsx banco/prepara.ts`), server acceso con le
 * Zone volute, Altoparlanti finti avviati (`npx tsx banco/altoparlanti-finti.ts 4`).
 */
import { spawnSync } from 'node:child_process'

import { progettoVuoto, type Zona } from '../src/engine/dominio/progetto.ts'
import { campionato, MixerZona } from '../src/engine/audio/mixer.ts'
import { PresaTcp } from '../src/engine/audio/presa-tcp.ts'
import { Scrittore } from '../src/engine/audio/scrittore.ts'
import { flussiDi } from '../src/engine/snapcast/configurazione.ts'
import { ClientRpc } from '../src/engine/snapcast/rpc.ts'

const DISTRO = process.env['REGIA_DISTRO'] ?? 'Ubuntu'
const CARTELLA_LOG = '/tmp/regia/finti'

function wsl(comando: string): string {
  const r = spawnSync('wsl', ['-d', DISTRO, '-u', 'root', '-e', 'bash', '-lc', comando], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24,
  })
  return (r.stdout ?? '').replace(/\u0000/g, '').trim()
}

const argomenti = process.argv.slice(2)
const secondi = Number(argomenti[0] ?? 60)
const anticipi = argomenti.length > 1 ? argomenti.slice(1).map(Number) : [50, 100, 200, 400, 1000]

const NOMI_ZONE = ['Ingresso', 'Cantina', 'Soffitta']

/** Sottofondo finto: un tono continuo, cosi il Flusso non e mai silenzio. */
function tono(secondiDurata: number, frequenza: number, canali: number, hz = 110) {
  const n = Math.floor(secondiDurata * frequenza)
  const c = new Int16Array(n * canali)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / frequenza) * 6000)
    for (let ch = 0; ch < canali; ch++) c[i * canali + ch] = v
  }
  return campionato('tono', c, canali)
}

/** Grandezze di risincronizzazione dai log degli Altoparlanti finti. */
function risincronizzazioni(): number[] {
  const testo = wsl(`grep -ihoP "resync[^0-9-]*\\K-?[0-9.]+" ${CARTELLA_LOG}/*.log 2>/dev/null || true`)
  return testo
    ? testo.split('\n').map((r) => Math.abs(Number(r))).filter((n) => !Number.isNaN(n))
    : []
}

/** Chunk che il client non e riuscito a suonare: sono buchi udibili. */
function chunkFalliti(): number {
  const n = wsl(
    `cat ${CARTELLA_LOG}/*.log 2>/dev/null | grep -c "Failed to get chunk\\|No chunks available" || echo 0`,
  )
  return Number(n) || 0
}

/** I client tengono il file aperto: si svuota con `:>`, non si tronca. */
function svuotaLog(): void {
  wsl(`for f in ${CARTELLA_LOG}/*.log; do :> "$f"; done 2>/dev/null || true`)
}

function percentile(valori: number[], p: number): number {
  if (valori.length === 0) return 0
  const ordinati = [...valori].sort((a, b) => a - b)
  return ordinati[Math.min(ordinati.length - 1, Math.floor((ordinati.length * p) / 100))]!
}

// ------------------------------------------------------------ esecuzione

const progetto = progettoVuoto('C:/Video')
progetto.zone = NOMI_ZONE.map(
  (nome, i): Zona => ({
    id: `z${i + 1}`, nome, colore: '#ff6600', ordine: i,
    volume: 1, sottofondoId: null, suoniAbilitati: null,
  }),
)
const flussi = flussiDi(progetto)

const rpc = new ClientRpc()
await rpc.collega()
const stato = await rpc.stato()
console.log(`Server: ${stato.streamIds.length} stream, ${stato.clienti.length} client collegati.`)
if (stato.clienti.length === 0) {
  console.log('Nessun Altoparlante finto: avviali con  npx tsx banco/altoparlanti-finti.ts 4')
}
console.log(
  `Scrivo su ${flussi.length} sorgenti (${flussi.map((f) => f.porta).join(', ')}), ` +
    `${secondi} s per ogni valore di anticipo.\n`,
)

console.log('anticipo | latenza | risincronizzazioni               | chunk persi | scarto | ritardo')
console.log('---------|---------|---------------------------------|-------------|--------|------')

for (const anticipo of anticipi) {
  const audio = { ...progetto.audio, anticipoMs: anticipo }
  svuotaLog()

  const scrittori = flussi.map((f) => {
    const mixer = new MixerZona(audio)
    mixer.impostaSottofondo(tono(2, audio.frequenza, audio.canali, 80 + f.porta - 4953))
    return new Scrittore({
      impostazioni: audio,
      mixer,
      collega: () => PresaTcp.apri('127.0.0.1', f.porta),
      suDiagnostica: (m) => {
        if (/caduta/.test(m)) console.error(`   [${f.id}] ${m}`)
      },
    })
  })

  for (const s of scrittori) s.avvia()
  await new Promise((r) => setTimeout(r, secondi * 1000))

  const diagnostiche = scrittori.map((s) => s.diagnostica())
  for (const s of scrittori) await s.ferma()

  const resync = risincronizzazioni()
  const falliti = chunkFalliti()
  const scartoMedio = Math.round(
    diagnostiche.reduce((n, d) => n + d.scartoMs, 0) / diagnostiche.length,
  )
  const ritardo = diagnostiche.reduce((n, d) => n + d.ritardoTotaleMs, 0)
  const dure = resync.filter((v) => v > 500).length

  const riassunto =
    resync.length === 0
      ? 'nessuna'
      : `${resync.length}, med ${percentile(resync, 50).toFixed(1)}, ` +
        `p95 ${percentile(resync, 95).toFixed(1)}, max ${Math.max(...resync).toFixed(0)} ms` +
        (dure > 0 ? ` -- ${dure} DURE` : '')

  console.log(
    `${String(anticipo).padStart(6)}ms | ${String(audio.bufferMs + anticipo).padStart(5)}ms | ` +
      `${riassunto.padEnd(31)} | ${String(falliti).padStart(11)} | ` +
      `${String(scartoMedio).padStart(4)}ms | ${ritardo} ms`,
  )
}

await rpc.chiudi()
console.log(`
Come si legge: contano solo le risincronizzazioni DURE (sopra 500 ms) -- sono le
uniche che si sentono -- e i chunk persi, che sono davvero buchi nell audio (il
ritardo dell ultima colonna invece non e audio mancante). La latenza e
cio che l Operatore aspettera fra il pulsante e l urlo. Si sceglie l anticipo piu
piccolo che non produce ne DURE ne chunk persi.
`)
