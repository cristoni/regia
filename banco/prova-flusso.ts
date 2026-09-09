/**
 * La prova che conta: scrivendo sulla sorgente TCP, lo stream passa davvero da
 * `idle` a `playing`, e i client smettono di dire "No chunks available"?
 *
 *   npx tsx banco/prova-flusso.ts [secondi]
 *
 * E l'unica conferma applicativa che snapserver stia LEGGENDO cio che gli
 * scriviamo: `connect()` che riesce non prova niente, perche il kernel accetta
 * e parcheggia anche le connessioni che snapserver non guardera mai.
 */
import { progettoVuoto, type Zona } from '../src/engine/dominio/progetto.ts'
import { campionato, MixerZona } from '../src/engine/audio/mixer.ts'
import { PresaTcp } from '../src/engine/audio/presa-tcp.ts'
import { Scrittore } from '../src/engine/audio/scrittore.ts'
import { flussiDi } from '../src/engine/snapcast/configurazione.ts'
import { ClientRpc } from '../src/engine/snapcast/rpc.ts'

const secondi = Number(process.argv[2] ?? 12)
const NOMI_ZONE = ['Ingresso', 'Cantina', 'Soffitta']

const progetto = progettoVuoto('C:/Video')
progetto.zone = NOMI_ZONE.map(
  (nome, i): Zona => ({
    id: `z${i + 1}`, nome, colore: '#ff6600', ordine: i,
    volume: 1, sottofondoId: null, suoniAbilitati: null,
  }),
)
const audio = progetto.audio
const flussi = flussiDi(progetto)

function tono(hz: number) {
  const n = audio.frequenza * 2
  const c = new Int16Array(n * audio.canali)
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / audio.frequenza) * 8000)
    for (let ch = 0; ch < audio.canali; ch++) c[i * audio.canali + ch] = v
  }
  return campionato('tono', c, audio.canali)
}

const rpc = new ClientRpc()
await rpc.collega()

async function statiStream(): Promise<Record<string, string>> {
  const r = await rpc.chiama<{ server: { streams: Array<{ id: string; status: string }> } }>(
    'Server.GetStatus',
  )
  return Object.fromEntries(r.server.streams.map((s) => [s.id, s.status]))
}

console.log('Stato degli stream PRIMA di scrivere:')
console.log(' ', await statiStream())

const scrittori = flussi.map((f, i) => {
  const mixer = new MixerZona(audio)
  mixer.impostaSottofondo(tono(110 + i * 55))
  return {
    flusso: f,
    scrittore: new Scrittore({
      impostazioni: audio,
      mixer,
      collega: () => PresaTcp.apri('127.0.0.1', f.porta),
      suDiagnostica: (m) => console.error(`   [${f.id}] ${m}`),
    }),
  }
})

console.log(`\nScrivo per ${secondi} s su ${flussi.length} sorgenti...`)
for (const s of scrittori) s.scrittore.avvia()

await new Promise((r) => setTimeout(r, 3000))
console.log('\nStato degli stream DOPO 3 s di scrittura:')
const dopo = await statiStream()
console.log(' ', dopo)

const suonanti = Object.entries(dopo).filter(([, s]) => s === 'playing')
if (suonanti.length === flussi.length) {
  console.log(`\n  Tutti e ${flussi.length} gli stream sono in "playing": snapserver sta leggendo.`)
} else {
  console.error(
    `\n  ATTENZIONE: solo ${suonanti.length} stream su ${flussi.length} in "playing".` +
      '\n  Gli altri sono connessi ma NON letti -- e la trappola della connessione parcheggiata.',
  )
}

await new Promise((r) => setTimeout(r, Math.max(0, secondi - 3) * 1000))

for (const { flusso, scrittore } of scrittori) {
  const d = scrittore.diagnostica()
  console.log(
    `  ${flusso.id.padEnd(15)} ${String(d.blocchiScritti).padStart(6)} blocchi, ` +
      `${(d.byteScritti / 1024).toFixed(0).padStart(6)} KB, scarto ${d.scartoMs.toFixed(0)} ms, ` +
      `ritardo ${d.ritardoTotaleMs} ms, cadute ${d.cadute}`,
  )
  await scrittore.ferma()
}

console.log('\nStato degli stream 2 s dopo aver smesso:')
await new Promise((r) => setTimeout(r, 2000))
console.log(' ', await statiStream())
await rpc.chiudi()
