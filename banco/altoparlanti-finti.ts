/**
 * Avvia N Altoparlanti finti **dentro la distro WSL**.
 *
 *   npx tsx banco/altoparlanti-finti.ts 4        # avvia
 *   npx tsx banco/altoparlanti-finti.ts --ferma  # spegne
 *   npx tsx banco/altoparlanti-finti.ts --stato
 *
 * Dentro la distro, e non su Windows, per una ragione misurata: il
 * `snapclient.exe` ufficiale per Windows **non riesce a sincronizzarsi** con un
 * snapserver Linux. Riporta `diff to server [ms]: -1.78885e+12` -- esattamente
 * l'ordine di grandezza dell'epoch Unix -- e da li in poi scarta ogni chunk
 * dicendo "No chunks available". Lo stesso client compilato per Linux, contro
 * lo stesso server, riporta `diff to server: 0.008 ms` e non perde un chunk.
 *
 * Non riguarda il prodotto: Snapdroid usa un client Android, che e la stessa
 * famiglia del client Linux. Riguarda solo il banco di prova, e l'[ADR 0008] e
 * stato corretto di conseguenza.
 */
import { spawnSync } from 'node:child_process'

const DISTRO = process.env['REGIA_DISTRO'] ?? 'Ubuntu'
const BINARIO = '/opt/snapclient-0.35/usr/bin/snapclient'
const CARTELLA_LOG = '/tmp/regia/finti'

/**
 * `pkill -x` sul nome esatto del processo, non `pkill -f` sulla riga di comando.
 *
 * Con `-f` il pattern contiene il percorso del binario -- che compare anche
 * nella riga di comando della bash che sta eseguendo il pkill. Risultato: la
 * shell uccide se stessa prima di arrivare al comando successivo, e tutto cio
 * che viene dopo (creare la cartella dei log, per esempio) non succede mai,
 * in silenzio.
 */
const FERMA = 'pkill -x snapclient 2>/dev/null; true'
const CONTA = 'pgrep -xc snapclient 2>/dev/null || echo 0'

function wsl(comando: string): string {
  const r = spawnSync('wsl', ['-d', DISTRO, '-u', 'root', '-e', 'bash', '-lc', comando], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24,
  })
  return (r.stdout ?? '').replace(/\0/g, '').trim()
}

const argomenti = process.argv.slice(2)

if (argomenti.includes('--ferma')) {
  wsl(FERMA)
  console.log('Altoparlanti finti spenti.')
  process.exit(0)
}

if (argomenti.includes('--stato')) {
  const vivi = wsl(CONTA)
  console.log(`Altoparlanti finti attivi: ${vivi}`)
  console.log(wsl(`grep -hoP "diff to server \\[ms\\]: \\K\\S+" ${CARTELLA_LOG}/*.log 2>/dev/null | tail -8 || true`))
  process.exit(0)
}

const quanti = Number(argomenti[0] ?? 3)
if (!Number.isInteger(quanti) || quanti < 1 || quanti > 24) {
  console.error('numero di Altoparlanti non valido (1-24)')
  process.exit(1)
}

if (!wsl(`test -x ${BINARIO} && echo ok`)) {
  console.error(`${BINARIO} non trovato nella distro ${DISTRO}. Esegui prima: npx tsx banco/prepara.ts`)
  process.exit(1)
}

wsl(`${FERMA}; sleep 1; mkdir -p ${CARTELLA_LOG}; rm -f ${CARTELLA_LOG}/*.log`)
if (!wsl(`test -d ${CARTELLA_LOG} && echo ok`)) {
  console.error(`non riesco a creare ${CARTELLA_LOG} nella distro ${DISTRO}`)
  process.exit(1)
}

// Un'invocazione di wsl.exe per client, e non tutte in una: incatenandole con
// `;` la shell esce prima che le ultime abbiano fatto in tempo a staccarsi, e
// ne sopravvive una sola.
//
// `file:filename=/dev/null` consuma i chunk al ritmo giusto senza toccare una
// scheda audio: e il "player nullo" che serve a un soak da sessanta minuti.
// `setsid` perche altrimenti muoiono con il wsl.exe che li ha lanciati.
for (let i = 0; i < quanti; i++) {
  const id = `finto-${i + 1}`
  wsl(
    `setsid ${BINARIO} --hostID ${id} --player file:filename=/dev/null ` +
      `--logfilter "*:info" --logsink file:${CARTELLA_LOG}/${id}.log ` +
      `tcp://127.0.0.1:1704 > /dev/null 2>&1 < /dev/null & disown; sleep 0.3`,
  )
}

// Il tempo di collegarsi e di scambiarsi i primi messaggi di sincronia.
await new Promise((r) => setTimeout(r, 3000))

const vivi = Number(wsl(CONTA))
console.log(`Avviati ${vivi} Altoparlanti finti su ${quanti} richiesti.`)

const scarti = wsl(`grep -hoP "diff to server \\[ms\\]: \\K\\S+" ${CARTELLA_LOG}/*.log 2>/dev/null || true`)
if (scarti) {
  console.log('\nScarto d orologio rispetto al server:')
  for (const riga of scarti.split('\n')) {
    const v = Math.abs(Number(riga))
    const giudizio = v < 50 ? 'ok' : v > 1e6 ? 'BASI TEMPORALI DIVERSE' : 'sospetto'
    console.log(`  ${riga.padStart(14)} ms  ${giudizio}`)
  }
}

console.log(`
Log dei client:   wsl -d ${DISTRO} -u root -e bash -lc 'tail -f ${CARTELLA_LOG}/finto-1.log'
Per spegnerli:    npx tsx banco/altoparlanti-finti.ts --ferma
`)
