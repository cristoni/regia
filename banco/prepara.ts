/**
 * Prepara il banco di prova su una macchina che non l'ha mai avuto.
 *
 *   npx tsx banco/prepara.ts
 *
 * Scarica gli strumenti ufficiali di Snapcast, versione **fissata**, e mette
 * snapserver dentro la Sede: la distro WSL su Windows, questo PC su Linux.
 * Esiste per una ragione precisa: senza, l'ambiente di collaudo vive solo nella
 * memoria di chi l'ha montato, e l'[ADR 0008] -- che fonda tutto il collaudo su
 * client finti -- sarebbe una promessa che nessun altro puo mantenere.
 *
 * I percorsi di destinazione non se li inventa questo script: `/opt/snapserver-0.35`
 * arriva da `sede.ts`, ed e il secondo posto in cui il motore va a cercare il
 * binario. Il banco installa esattamente dove Regia guarda, cosi preparare il
 * banco prepara anche il prodotto.
 *
 * Cosa tocca del sistema, e come si disfa:
 *   - `vendor/snapclient/`      nel repo, non versionato, solo Windows -> si cancella
 *   - `/opt/snapserver-0.35/`   dentro la Sede                         -> `rm -rf`
 *   - `/opt/snapclient-0.35/`   dentro la Sede                         -> `rm -rf`
 *   - la cartella di lavoro della Sede                                 -> `rm -rf`
 * Nessun pacchetto installato, nessuna configurazione di sistema cambiata.
 *
 * Su Linux `/opt` non appartiene all'utente che lancia Regia: serve `sudo`, e lo
 * script lo chiede una volta prima di scaricare. Il perche di quella scelta --
 * invece di `~/.local` piu `REGIA_SNAPSERVER` -- sta in `prefissoRoot()`.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  BINARIO_SNAPCLIENT,
  BINARIO_SNAPSERVER,
  CARTELLA_LOG,
  DENTRO_WSL,
  DISTRO,
  PREFISSO_SNAPCLIENT,
  PREFISSO_SNAPSERVER,
  nellaSede,
  nellaSedeOFallisci,
  prefissoRoot,
  sede,
} from './sede-banco.ts'

/** Versione fissata: il collaudo deve dare lo stesso risultato fra sei mesi. */
const VERSIONE = '0.35.0'

/**
 * Scaricare un .deb da centotrenta megabyte dentro una distro non e un comando
 * da quindici secondi, che e il timeout di `eseguiProcesso`. Scaduto quello il
 * processo viene ucciso e l'esito torna diverso da zero senza dire perche: il
 * sintomo sarebbe "curl fallisce sempre, e nessun errore di rete".
 */
const TEMPO_SCARICO = 360_000

const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scarica = (nome: string) =>
  `https://github.com/badaix/snapcast/releases/download/v${VERSIONE}/${nome}`

function passo(testo: string): void {
  process.stdout.write(`\n=== ${testo} ===\n`)
}

// -------------------------------------- snapclient per Windows (diagnostica)

/**
 * Solo su Windows, e solo per guardare a mano cosa succede.
 *
 * Su Linux non c'e nessun `snapclient.exe` da estrarre e nessun PowerShell con
 * cui estrarlo: il pezzo si salta, non fallisce. Saltarlo non toglie niente al
 * banco -- gli Altoparlanti finti sono il client Linux, e quello si installa
 * dentro la Sede piu sotto.
 */
if (process.platform === 'win32') {
  passo(`snapclient ${VERSIONE} per Windows`)
  console.log(
    'Nota: serve solo per diagnosticare a mano. Gli Altoparlanti finti girano dentro\n' +
      'la Sede, perche il client Windows NON si sincronizza con un server Linux\n' +
      '(riporta uno scarto d orologio di un epoch Unix). Vedi docs/fatti-verificati.md.',
  )
  const cartellaClient = path.join(radice, 'vendor', 'snapclient')
  const esistente = await fs
    .access(path.join(cartellaClient, 'snapclient.exe'))
    .then(() => true)
    .catch(() => false)

  if (esistente) {
    console.log('gia presente in vendor/snapclient')
  } else {
    await fs.mkdir(cartellaClient, { recursive: true })
    const zip = path.join(cartellaClient, 'snapclient.zip')
    console.log('scarico snapclient_win64.zip...')
    const risposta = await fetch(scarica('snapclient_win64.zip'))
    if (!risposta.ok) throw new Error(`scaricamento fallito: HTTP ${risposta.status}`)
    await fs.writeFile(zip, Buffer.from(await risposta.arrayBuffer()))

    // Expand-Archive e in PowerShell da sempre: niente da installare.
    const e = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${cartellaClient}' -Force`],
      { encoding: 'utf8', windowsHide: true },
    )
    if (e.status !== 0) throw new Error(`estrazione fallita: ${e.stderr}`)
    await fs.rm(zip, { force: true })

    // Lo zip a volte contiene una cartella intermedia: si appiattisce.
    for (const voce of await fs.readdir(cartellaClient, { withFileTypes: true })) {
      if (!voce.isDirectory()) continue
      const dentro = path.join(cartellaClient, voce.name)
      for (const f of await fs.readdir(dentro)) {
        await fs.rename(path.join(dentro, f), path.join(cartellaClient, f))
      }
      await fs.rm(dentro, { recursive: true, force: true })
    }
    console.log(`estratto: ${(await fs.readdir(cartellaClient)).join(', ')}`)
  }

  const versioneClient = spawnSync(path.join(cartellaClient, 'snapclient.exe'), ['-v'], {
    encoding: 'utf8', windowsHide: true,
  })
  console.log((versioneClient.stdout ?? versioneClient.stderr ?? '').trim().split('\n')[0])
}

// ------------------------------------------------ gli attrezzi della Sede

/**
 * `curl` e `dpkg-deb` prima di tutto il resto.
 *
 * Nella distro dell'ADR 0003 ci sono per costruzione, ma su Linux la Sede e il
 * PC di chi c'e: su una Fedora o una Arch `dpkg-deb` non esiste, e il sintomo
 * senza questo controllo sarebbe un `command not found` in mezzo a un `set -e`,
 * dopo aver scaricato il pacchetto.
 */
passo(`gli attrezzi della Sede (${sede.descrizione})`)
const manca = await nellaSede(
  'for c in curl dpkg-deb ldd; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done; true',
)
if (manca) {
  throw new Error(
    `nella Sede (${sede.descrizione}) mancano: ${manca.split('\n').join(', ')}.\n` +
      'Il banco estrae il .deb ufficiale di Snapcast, quindi `dpkg-deb` serve davvero.\n' +
      'Su una distribuzione non Debian: installa snapserver >= 0.33 come sa fare lei, ' +
      'e indica il binario a Regia con REGIA_SNAPSERVER=/percorso/snapserver.',
  )
}
console.log('curl, dpkg-deb, ldd: ci sono')

/**
 * Vuoto su Windows (la distro entra gia come root), `sudo -n ` su Linux.
 *
 * Non si chiede la password quando non c'e niente da installare: `prepara.ts` si
 * rilancia spesso solo per rileggere le istruzioni finali, e farsi chiedere
 * `sudo` per non fare niente insegna a darlo senza guardare.
 */
const giaCiSono = await nellaSede(
  `test -x ${BINARIO_SNAPSERVER} && test -x ${BINARIO_SNAPCLIENT} && echo ok`,
)
const ROOT = giaCiSono ? '' : prefissoRoot()

// ------------------------------------------------- snapserver nella Sede

passo(`snapserver ${VERSIONE} nella Sede (${sede.descrizione})`)

// Il .deb e Debian bookworm. Su Ubuntu 24.04 `dpkg -i` fallirebbe perche la
// transizione time_t ha rinominato libflac12 in libflac12t64 -- ma sono solo
// metadati del pacchetto: i .so hanno lo stesso SONAME. Quindi si ESTRAE
// invece di installare. Verificato: ldd non riporta nulla di mancante.
const deb = `snapserver_${VERSIONE}-1_amd64_bookworm.deb`
console.log(
  await nellaSedeOFallisci(
    `
    set -e
    if [ -x ${BINARIO_SNAPSERVER} ]; then echo "gia presente in ${PREFISSO_SNAPSERVER}"; else
      cd /tmp
      curl -sL --max-time 300 -o "${deb}" "${scarica(deb)}"
      ${ROOT}rm -rf ${PREFISSO_SNAPSERVER}
      ${ROOT}mkdir -p ${PREFISSO_SNAPSERVER}
      ${ROOT}dpkg-deb -x "${deb}" ${PREFISSO_SNAPSERVER}
      rm -f "${deb}"
      echo "estratto in ${PREFISSO_SNAPSERVER}"
    fi
  `,
    { timeoutMs: TEMPO_SCARICO },
  ),
)

const mancanti = await nellaSede(`ldd ${BINARIO_SNAPSERVER} | grep -i "not found" || true`, {
  timeoutMs: 60_000,
})
if (mancanti) {
  throw new Error(
    `librerie mancanti nella Sede (${sede.descrizione}):\n${mancanti}\n` +
      'Il .deb e per Debian bookworm: su una distribuzione lontana da quella le librerie ' +
      'possono non esserci. Installale a mano, oppure usa lo snapserver della tua ' +
      'distribuzione (>= 0.33) e indicalo con REGIA_SNAPSERVER.',
  )
}
console.log('nessuna libreria mancante')
console.log(await nellaSedeOFallisci(`${BINARIO_SNAPSERVER} -v | head -1`, { timeoutMs: 30_000 }))

// -------------------------------- snapclient per Linux: gli Altoparlanti finti

passo(`snapclient ${VERSIONE} nella Sede (${sede.descrizione}): gli Altoparlanti finti`)
const debClient = `snapclient_${VERSIONE}-1_amd64_bookworm.deb`
console.log(
  await nellaSedeOFallisci(
    `
    set -e
    if [ -x ${BINARIO_SNAPCLIENT} ]; then echo "gia presente in ${PREFISSO_SNAPCLIENT}"; else
      cd /tmp
      curl -sL --max-time 300 -o "${debClient}" "${scarica(debClient)}"
      ${ROOT}rm -rf ${PREFISSO_SNAPCLIENT}
      ${ROOT}mkdir -p ${PREFISSO_SNAPCLIENT}
      ${ROOT}dpkg-deb -x "${debClient}" ${PREFISSO_SNAPCLIENT}
      rm -f "${debClient}"
      echo "estratto in ${PREFISSO_SNAPCLIENT}"
    fi
  `,
    { timeoutMs: TEMPO_SCARICO },
  ),
)
const mancantiClient = await nellaSede(`ldd ${BINARIO_SNAPCLIENT} | grep -i "not found" || true`, {
  timeoutMs: 60_000,
})
if (mancantiClient) throw new Error(`librerie mancanti per snapclient: ${mancantiClient}`)
console.log(await nellaSedeOFallisci(`${BINARIO_SNAPCLIENT} -v | head -1`, { timeoutMs: 30_000 }))

// ------------------------------------------------- le cartelle di lavoro

/**
 * Senza `${ROOT}`, e non e una svista: queste cartelle le scrive Regia mentre
 * gira, cioe l'utente che ha fatto login. Crearle da root su Linux le renderebbe
 * illeggibili proprio a chi deve usarle, e il guasto arriverebbe piu tardi --
 * quando snapserver non riesce a scrivere il suo `server.log` e non parte.
 * Dentro la distro il punto non si pone: li si e root e basta (ADR 0003).
 */
passo('le cartelle di lavoro')
await nellaSedeOFallisci(`mkdir -p ${sede.cartellaLavoro} ${sede.datadir} ${CARTELLA_LOG}`)
console.log(`${sede.cartellaLavoro}, ${sede.datadir}, ${CARTELLA_LOG}`)

// -------------------------------------------------------------- istruzioni

const conf = `${sede.cartellaLavoro}/snapserver.conf`
const log = `${sede.cartellaLavoro}/server.log`

/**
 * `setsid nohup`, e non solo `setsid` come fa il supervisore.
 *
 * I due comandi partono da posti diversi. Il supervisore lo lancia da un
 * processo lungo, con le sue pipe: `setsid` gli basta. Questo invece lo incolla
 * una persona dentro un terminale che poi chiudera, e alla chiusura il terminale
 * manda SIGHUP a chi era suo -- `nohup` e la seconda cintura, costa niente, ed
 * era li nella versione di questo testo che qualcuno ha provato a mano.
 */
const avvio = `setsid nohup ${BINARIO_SNAPSERVER} -c ${conf} > ${log} 2>&1 < /dev/null &`

passo('Banco pronto')
console.log(
  DENTRO_WSL
    ? `
Per avviare il server con una configurazione generata da Regia:

  npx tsx banco/genera-conf.ts Ingresso Cantina Soffitta > /tmp/rg.conf
  wsl -d ${DISTRO} -u root -e bash -lc 'mkdir -p ${sede.datadir} && cat > ${conf}' < /tmp/rg.conf
  wsl -d ${DISTRO} -u root -e bash -lc \\
    '${avvio} disown'

Il \`mkdir -p\` nella seconda riga non e ridondante anche se prepara.ts ha appena
creato quelle cartelle: il \`/tmp\` della distro si svuota a ogni riavvio della
distro, e la distro si spegne da sola quando nessuno le parla (misurato oggi: due
volte a pochi minuti di distanza, e la riga dopo falliva con "No such file or
directory"). Li si puo usare \`&&\` perche in quel comando non c'e nessun \`&\` a
contendersi la precedenza; nella riga di avvio, che finisce con \`&\`, un \`&&\`
davanti manderebbe in background tutta la lista e non succederebbe niente.

\`setsid\` non e un vezzo: senza, snapserver riceve SIGHUP e muore appena esce il
wsl.exe che l'ha lanciato, e \`nohup\` da solo non basta.
`
    : `
Per avviare il server con una configurazione generata da Regia:

  mkdir -p ${sede.datadir}
  npx tsx banco/genera-conf.ts Ingresso Cantina Soffitta > ${conf}
  ${avvio}

Nessun \`wsl\`, nessun \`-u root\`: la Sede e questo PC, e snapserver gira come te.
\`setsid\` resta perche e cosi che lo avvia il supervisore, e il banco deve provare
quel comando li, non uno somigliante; \`nohup\` in piu perche questo lo scrivi tu
in un terminale che poi chiudi.
`,
)

console.log(`Per gli Altoparlanti finti (girano DENTRO la Sede: ${sede.descrizione}):

  npx tsx banco/altoparlanti-finti.ts 4

Poi:
  npx tsx banco/prova-flusso.ts        verifica che gli stream vadano in playing
  npx tsx banco/riconcilia-dal-vero.ts riconcilia contro il server vero
  npx tsx banco/scrivi-dal-vero.ts     misura l'anticipo di scrittura
`)
