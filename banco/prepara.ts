/**
 * Prepara il banco di prova su una macchina che non l'ha mai avuto.
 *
 *   npx tsx banco/prepara.ts
 *
 * Scarica gli strumenti ufficiali di Snapcast, versione **fissata**, e mette
 * snapserver dentro la distro WSL. Esiste per una ragione precisa: senza,
 * l'ambiente di collaudo vive solo nella memoria di chi l'ha montato, e
 * l'[ADR 0008] -- che fonda tutto il collaudo su client finti -- sarebbe una
 * promessa che nessun altro puo mantenere.
 *
 * Cosa tocca del sistema, e come si disfa:
 *   - `vendor/snapclient/`     nel repo, non versionato   -> si cancella
 *   - `/opt/snapserver-0.35/`  dentro la distro WSL        -> `rm -rf`
 *   - `/opt/snapclient-0.35/`  dentro la distro WSL        -> `rm -rf`
 * Nessun pacchetto installato, nessuna configurazione di sistema cambiata.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Versione fissata: il collaudo deve dare lo stesso risultato fra sei mesi. */
const VERSIONE = '0.35.0'
const DISTRO = process.env['REGIA_DISTRO'] ?? 'Ubuntu'
const PREFISSO_WSL = '/opt/snapserver-0.35'

const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scarica = (nome: string) =>
  `https://github.com/badaix/snapcast/releases/download/v${VERSIONE}/${nome}`

function passo(testo: string): void {
  process.stdout.write(`\n=== ${testo} ===\n`)
}

function wsl(comando: string, input?: string): string {
  const r = spawnSync('wsl', ['-d', DISTRO, '-u', 'root', '-e', 'bash', '-lc', comando], {
    input, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24,
  })
  const pulito = (r.stdout ?? '').replace(/\0/g, '')
  if (r.status !== 0) {
    throw new Error(`comando fallito nella distro ${DISTRO}:\n${comando}\n${pulito}${r.stderr ?? ''}`)
  }
  return pulito.trim()
}

// -------------------------------------- snapclient per Windows (diagnostica)

passo(`snapclient ${VERSIONE} per Windows`)
console.log(
  'Nota: serve solo per diagnosticare a mano. Gli Altoparlanti finti girano dentro\n' +
    'la distro, perche il client Windows NON si sincronizza con un server Linux\n' +
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

// ------------------------------------------------- snapserver nella distro

passo(`snapserver ${VERSIONE} nella distro WSL "${DISTRO}"`)

// Il .deb e Debian bookworm. Su Ubuntu 24.04 `dpkg -i` fallirebbe perche la
// transizione time_t ha rinominato libflac12 in libflac12t64 -- ma sono solo
// metadati del pacchetto: i .so hanno lo stesso SONAME. Quindi si ESTRAE
// invece di installare. Verificato: ldd non riporta nulla di mancante.
const deb = `snapserver_${VERSIONE}-1_amd64_bookworm.deb`
console.log(
  wsl(`
    set -e
    if [ -x ${PREFISSO_WSL}/usr/bin/snapserver ]; then echo "gia presente in ${PREFISSO_WSL}"; else
      cd /tmp
      curl -sL --max-time 300 -o "${deb}" "${scarica(deb)}"
      rm -rf ${PREFISSO_WSL} && mkdir -p ${PREFISSO_WSL}
      dpkg-deb -x "${deb}" ${PREFISSO_WSL}
      rm -f "${deb}"
      echo "estratto in ${PREFISSO_WSL}"
    fi
    mkdir -p /var/lib/snapserver /tmp/regia
  `),
)

const mancanti = wsl(`ldd ${PREFISSO_WSL}/usr/bin/snapserver | grep -i "not found" || true`)
if (mancanti) {
  throw new Error(
    `librerie mancanti nella distro ${DISTRO}:\n${mancanti}\n` +
      'Serve una distro diversa, o installare le dipendenze a mano.',
  )
}
console.log('nessuna libreria mancante')
console.log(wsl(`${PREFISSO_WSL}/usr/bin/snapserver -v | head -1`))

// ------------------------------- snapclient per Linux: gli Altoparlanti finti

passo(`snapclient ${VERSIONE} nella distro (Altoparlanti finti)`)
const debClient = `snapclient_${VERSIONE}-1_amd64_bookworm.deb`
const PREFISSO_CLIENT = '/opt/snapclient-0.35'
console.log(
  wsl(`
    set -e
    if [ -x ${PREFISSO_CLIENT}/usr/bin/snapclient ]; then echo "gia presente in ${PREFISSO_CLIENT}"; else
      cd /tmp
      curl -sL --max-time 300 -o "${debClient}" "${scarica(debClient)}"
      rm -rf ${PREFISSO_CLIENT} && mkdir -p ${PREFISSO_CLIENT}
      dpkg-deb -x "${debClient}" ${PREFISSO_CLIENT}
      rm -f "${debClient}"
      echo "estratto in ${PREFISSO_CLIENT}"
    fi
    mkdir -p /tmp/regia/finti
  `),
)
const mancantiClient = wsl(`ldd ${PREFISSO_CLIENT}/usr/bin/snapclient | grep -i "not found" || true`)
if (mancantiClient) throw new Error(`librerie mancanti per snapclient: ${mancantiClient}`)
console.log(wsl(`${PREFISSO_CLIENT}/usr/bin/snapclient -v | head -1`))

// -------------------------------------------------------------- istruzioni

passo('Banco pronto')
console.log(`
Per avviare il server con una configurazione generata da Regia:

  npx tsx banco/genera-conf.ts Ingresso Cantina Soffitta > /tmp/regia.conf
  wsl -d ${DISTRO} -u root -e bash -lc 'cat > /tmp/regia/snapserver.conf' < /tmp/regia.conf
  wsl -d ${DISTRO} -u root -e bash -lc \\
    'setsid nohup ${PREFISSO_WSL}/usr/bin/snapserver -c /tmp/regia/snapserver.conf \\
     > /tmp/regia/server.log 2>&1 < /dev/null & disown'

\`setsid\` non e un vezzo: senza, snapserver riceve SIGHUP e muore appena esce il
wsl.exe che l'ha lanciato, e \`nohup\` da solo non basta.

Per gli Altoparlanti finti (girano DENTRO la distro, non su Windows):

  npx tsx banco/altoparlanti-finti.ts 4

Poi:
  npx tsx banco/prova-flusso.ts        verifica che gli stream vadano in playing
  npx tsx banco/riconcilia-dal-vero.ts riconcilia contro il server vero
  npx tsx banco/scrivi-dal-vero.ts     misura l'anticipo di scrittura
`)
