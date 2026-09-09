/**
 * Mette il thread principale sotto carico e guarda se l'audio regge.
 *
 *   npx tsx banco/carico-dal-vero.ts [secondi] [--senza-carico]
 *
 * E la prova per cui il thread audio esiste. Prima di spostarlo, con quattro
 * scrittori sul thread principale, lo scrittore restava indietro di oltre mezzo
 * secondo e rinunciava a pezzi di Flusso. Qui si fa di peggio -- si blocca il
 * thread principale apposta, ripetutamente -- e si guarda `buchiMs`.
 *
 * Il carico e volutamente brutale e sincrono: un ciclo che occupa la CPU per
 * decine di millisecondi, come farebbe una decodifica video andata storta o una
 * serializzazione grossa. Se il Flusso regge questo, regge sei anteprime video.
 *
 * Presuppone: banco preparato, snapserver acceso con Ingresso/Cantina/Soffitta.
 */
import { progettoVuoto, type Zona } from '../src/engine/dominio/progetto.ts'
import { MotoreAudio } from '../src/engine/audio/motore-audio.ts'
import { flussiDi } from '../src/engine/snapcast/configurazione.ts'

const secondi = Number(process.argv[2] ?? 30)
const conCarico = !process.argv.includes('--senza-carico')
const NOMI_ZONE = ['Ingresso', 'Cantina', 'Soffitta']

const progetto = progettoVuoto('C:/Video')
progetto.zone = NOMI_ZONE.map(
  (nome, i): Zona => ({
    id: `z${i + 1}`, nome, colore: '#ff6600', ordine: i,
    volume: 1, sottofondoId: null, suoniAbilitati: null,
  }),
)
const flussi = flussiDi(progetto)

const diario: string[] = []
const audio = new MotoreAudio({ suDiario: (l, t) => diario.push(`[${l}] ${t}`) })
await audio.aspettaPronto()

audio.configura(
  progetto.audio,
  flussi.map((f) => ({ id: f.id, zonaId: f.zonaId, porta: f.porta, volume: 1 })),
)
audio.avvia()

console.log(
  `${flussi.length} Flussi, ${secondi} s, carico sul thread principale: ` +
    `${conCarico ? 'SI' : 'no'}\n`,
)

/** Blocca il thread principale per davvero: niente await, niente cortesia. */
function bloccaPer(ms: number): void {
  const fine = performance.now() + ms
  let x = 0
  while (performance.now() < fine) x += Math.sqrt(x + 1)
  if (x < 0) console.log(x)
}

let bloccoTotale = 0
let bloccoMassimo = 0
const fine = Date.now() + secondi * 1000
let giro = 0

while (Date.now() < fine) {
  if (conCarico) {
    // Blocchi irregolari fra 10 e 120 ms: il profilo di un thread che fa altro.
    const ms = 10 + ((giro * 37) % 110)
    bloccaPer(ms)
    bloccoTotale += ms
    bloccoMassimo = Math.max(bloccoMassimo, ms)
  }
  await new Promise((r) => setTimeout(r, 20))
  giro++
}

const stato = audio.stato()
console.log('Flusso            stato       buchi     scarto   cadute')
console.log('----------------- ----------- --------- -------- ------')
for (const f of stato) {
  console.log(
    `${f.id.padEnd(17)} ${f.scrittore.padEnd(11)} ${String(f.buchiMs + ' ms').padStart(9)} ` +
      `${String(f.scartoMs + 'ms').padStart(8)} ${String(f.cadute).padStart(6)}`,
  )
}

const buchi = stato.reduce((n, f) => n + f.buchiMs, 0)
console.log(
  `\nThread principale bloccato per ${(bloccoTotale / 1000).toFixed(1)} s su ${secondi}` +
    ` (blocco piu lungo: ${bloccoMassimo} ms).`,
)
console.log(`Flusso perso in totale: ${buchi} ms su ${flussi.length} Flussi.`)
console.log(
  buchi === 0
    ? 'Nessun buco: il thread audio non si e accorto di niente.'
    : 'ATTENZIONE: il thread audio ha perso Flusso nonostante sia separato.',
)
if (diario.length) console.log('\nDiario:\n  ' + diario.slice(0, 8).join('\n  '))

await audio.chiudi()
