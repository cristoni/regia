/**
 * Avvia N Altoparlanti finti **dentro la Sede**.
 *
 *   npx tsx banco/altoparlanti-finti.ts 4        # avvia
 *   npx tsx banco/altoparlanti-finti.ts --ferma  # spegne
 *   npx tsx banco/altoparlanti-finti.ts --stato
 *
 * Dentro la Sede, e non su Windows, per una ragione **misurata**: il
 * `snapclient.exe` ufficiale per Windows non riesce a sincronizzarsi con un
 * snapserver Linux. Riporta `diff to server [ms]: -1.78885e+12` -- esattamente
 * l'ordine di grandezza dell'epoch Unix -- e da li in poi scarta ogni chunk
 * dicendo "No chunks available". Lo stesso client compilato per Linux, contro
 * lo stesso server, riporta `diff to server: 0.008 ms` e non perde un chunk.
 *
 * Non riguarda il prodotto: Snapdroid usa un client Android, che e la stessa
 * famiglia del client Linux. Riguarda solo il banco di prova, e l'[ADR 0008] e
 * stato corretto di conseguenza.
 *
 * Quella misura e del caso Windows, ed e la ragione per cui il banco passa dalla
 * distro invece di lanciare il client sull'host. Quando la Sede e Linux il giro
 * non serve nemmeno: il client che si avvia e gia quello nativo, sulla stessa
 * macchina del server. Non e stato provato -- questa macchina e Windows -- ma il
 * meccanismo che rompeva le basi temporali sull'host non c'e piu, e comunque il
 * comando resta identico, perche passa sempre dalla Sede.
 */
import {
  BINARIO_SNAPCLIENT,
  CARTELLA_LOG,
  comeSiScrive,
  nellaSede,
  sede,
} from './sede-banco.ts'

/**
 * Si spegne per PID, guardando la riga di comando di ogni processo, e non con
 * `pkill -x snapclient`.
 *
 * `pkill -x` andava bene finche la Sede era una distro dedicata a Regia (ADR
 * 0003), dove l'unico snapclient acceso e per forza nostro. Su Linux la Sede e
 * il PC dell'Operatore: uno `snapclient` avviato da lui per altro morirebbe
 * insieme ai nostri, e il banco avrebbe rotto qualcosa che non gli appartiene.
 *
 * Non si usa nemmeno `pkill -f`: con `-f` il pattern contiene il percorso del
 * binario -- che compare anche nella riga di comando della bash che sta
 * eseguendo il pkill. Risultato: la shell uccide se stessa prima di arrivare al
 * comando successivo, e tutto cio che viene dopo (creare la cartella dei log,
 * per esempio) non succede mai, in silenzio.
 *
 * `pgrep -x snapclient` invece elenca solo processi che si chiamano davvero
 * snapclient -- mai la nostra shell -- e l'`--hostID` nella riga di comando
 * dice quali sono i nostri.
 *
 * ⚠️ **Si riconoscono dall'`--hostID`, non dalla cartella dei log**, e la
 * differenza conta. `CARTELLA_LOG` deriva da `sede.cartellaLavoro`, che su
 * Linux e `$XDG_RUNTIME_DIR/regia` quando la variabile c'e e
 * `os.tmpdir()/regia-<uid>` quando non c'e. Basta che il giro che avvia e il
 * giro che spegne partano da contesti diversi -- un terminale grafico e una
 * sessione `ssh`, per dirne due -- perche il percorso cambi: `--ferma` non
 * riconoscerebbe piu nessuno, direbbe di aver spento tutto, e lascerebbe
 * dietro di se una dozzina di client che continuano a consumare il Flusso. Il
 * prefisso dell'`--hostID` invece e una costante di questo file.
 *
 * I `true` finali non sono ornamentali: senza, l'esito del comando e quello
 * dell'ultimo `grep`, e un giro che non trova niente farebbe credere a un errore.
 * E `CONTA` mette il ciclo dentro `{ ...; }` perche una pipe si attacca solo
 * all'ultimo comando della lista: `done; true | wc -l` conterebbe le righe di
 * `true`, cioe sempre zero, e il banco direbbe che non e partito niente.
 */
/** Il prefisso dell'`--hostID`: e cio che distingue i nostri da un client vero. */
const PREFISSO_FINTO = 'regia-finto'

const NOSTRI =
  `for q in $(pgrep -x snapclient 2>/dev/null); do ` +
  `tr '\\0' ' ' < /proc/$q/cmdline 2>/dev/null | grep -qF -- '--hostID ${PREFISSO_FINTO}-' && echo $q; ` +
  `done`
const FERMA = `for p in $(${NOSTRI}); do kill $p 2>/dev/null; done; true`
const CONTA = `{ ${NOSTRI}; } | wc -l`

const argomenti = process.argv.slice(2)

if (argomenti.includes('--ferma')) {
  await nellaSede(FERMA)
  console.log('Altoparlanti finti spenti.')
  process.exit(0)
}

if (argomenti.includes('--stato')) {
  const vivi = await nellaSede(CONTA)
  console.log(`Altoparlanti finti attivi: ${vivi}`)
  console.log(
    await nellaSede(
      `grep -hoP "diff to server \\[ms\\]: \\K\\S+" ${CARTELLA_LOG}/*.log 2>/dev/null | tail -8 || true`,
    ),
  )
  process.exit(0)
}

const quanti = Number(argomenti[0] ?? 3)
if (!Number.isInteger(quanti) || quanti < 1 || quanti > 24) {
  console.error('numero di Altoparlanti non valido (1-24)')
  process.exit(1)
}

if (!(await nellaSede(`test -x ${BINARIO_SNAPCLIENT} && echo ok`))) {
  console.error(
    `${BINARIO_SNAPCLIENT} non trovato nella Sede (${sede.descrizione}).\n` +
      'Esegui prima: npx tsx banco/prepara.ts',
  )
  process.exit(1)
}

await nellaSede(`${FERMA}; sleep 1; mkdir -p ${CARTELLA_LOG}; rm -f ${CARTELLA_LOG}/*.log`)
if (!(await nellaSede(`test -d ${CARTELLA_LOG} && echo ok`))) {
  console.error(`non riesco a creare ${CARTELLA_LOG} nella Sede (${sede.descrizione})`)
  process.exit(1)
}

// Un'invocazione della Sede per client, e non tutte in una: incatenandole con
// `;` la shell esce prima che le ultime abbiano fatto in tempo a staccarsi, e
// ne sopravvive una sola.
//
// `file:filename=/dev/null` consuma i chunk al ritmo giusto senza toccare una
// scheda audio: e il "player nullo" che serve a un soak da sessanta minuti.
// `setsid` perche altrimenti muoiono con la shell che li ha lanciati.
//
// Il `127.0.0.1` e **dentro la Sede**, non su Windows: e il loopback della
// macchina dove gira snapserver, cioe la sua stessa. Non c'entra nulla con la
// trappola degli inoltri fantasma dell'ADR 0010, che riguarda un `connect()`
// fatto da Windows verso la distro.
for (let i = 0; i < quanti; i++) {
  const id = `${PREFISSO_FINTO}-${i + 1}`
  await nellaSede(
    `setsid ${BINARIO_SNAPCLIENT} --hostID ${id} --player file:filename=/dev/null ` +
      `--logfilter "*:info" --logsink file:${CARTELLA_LOG}/${id}.log ` +
      `tcp://127.0.0.1:1704 > /dev/null 2>&1 < /dev/null & disown; sleep 0.3`,
  )
}

// Il tempo di collegarsi e di scambiarsi i primi messaggi di sincronia.
await new Promise((r) => setTimeout(r, 3000))

const vivi = Number(await nellaSede(CONTA))
console.log(`Avviati ${vivi} Altoparlanti finti su ${quanti} richiesti.`)

const scarti = await nellaSede(
  `grep -hoP "diff to server \\[ms\\]: \\K\\S+" ${CARTELLA_LOG}/*.log 2>/dev/null || true`,
)
if (scarti) {
  console.log('\nScarto d orologio rispetto al server:')
  for (const riga of scarti.split('\n')) {
    const v = Math.abs(Number(riga))
    const giudizio = v < 50 ? 'ok' : v > 1e6 ? 'BASI TEMPORALI DIVERSE' : 'sospetto'
    console.log(`  ${riga.padStart(14)} ms  ${giudizio}`)
  }
}

console.log(`
Log dei client:   ${comeSiScrive(`tail -f ${CARTELLA_LOG}/${PREFISSO_FINTO}-1.log`)}
Per spegnerli:    npx tsx banco/altoparlanti-finti.ts --ferma
`)
