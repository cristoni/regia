/**
 * La Sede, vista dal banco di prova.
 *
 * Prima di questo file ogni script del banco si portava dietro la sua `wsl()`:
 * sette copie di `spawnSync('wsl', ['-d', DISTRO, '-u', 'root', ...])`, e sette
 * posti in cui il banco era intestato a Windows. Il motore nel frattempo ha
 * imparato la Sede (`src/engine/snapcast/sede.ts`, ADR 0011) -- la macchina dove
 * gira snapserver, una distro WSL su Windows e il PC stesso su Linux -- e il
 * banco deve saperlo, altrimenti resta l'unica parte del progetto che su Linux
 * non si puo provare: proprio sulla macchina dove serve provarla.
 *
 * La scelta fra le due Sedi si fa **qui e una volta sola**. Gli script sopra non
 * sanno se il comando finisce dentro una macchina virtuale o dentro una `bash` a
 * due centimetri: sanno che c'e una Sede e che dentro ci sono snapserver, gli
 * Altoparlanti finti e i log.
 *
 * ⚠️ Il banco usa la Sede **vera**, quella del motore, e non una imitazione: se
 * il banco parlasse alla distro in un modo diverso da come le parla Regia,
 * misurerebbe un ambiente che al debutto non esistera.
 */
import { spawnSync } from 'node:child_process'

import { progettoVuoto, type ImpostazioniServer } from '../src/engine/dominio/progetto.ts'
import {
  sedeDi,
  type OpzioniEsecuzione,
  type Sede,
} from '../src/engine/snapcast/sede.ts'

export { BINARIO_SNAPSERVER, PREFISSO_SNAPSERVER } from '../src/engine/snapcast/sede.ts'

/**
 * Il nome della distro per il banco, che **non** e quello del prodotto.
 *
 * `progettoVuoto` propone `Regia-Snapserver`, la distro dedicata dell'ADR 0003;
 * il banco gira da anni contro `Ubuntu`, che e quella installata a mano su
 * questa macchina. Su Linux il campo non lo guarda nessuno.
 */
export const DISTRO = process.env['REGIA_DISTRO'] ?? 'Ubuntu'

/** Di tutte le impostazioni server, `sedeDi` guarda solo `distro`. */
const IMPOSTAZIONI: ImpostazioniServer = { ...progettoVuoto('.').server, distro: DISTRO }

export const sede: Sede = sedeDi(IMPOSTAZIONI)

/** Vero quando snapserver sta in una distro e i comandi passano da `wsl.exe`. */
export const DENTRO_WSL = sede.genere === 'wsl'

/** Dove il banco mette i log degli Altoparlanti finti, dentro la Sede. */
export const CARTELLA_LOG = `${sede.cartellaLavoro}/finti`

/** Il gemello di `PREFISSO_SNAPSERVER` per il client: lo usa solo il banco. */
export const PREFISSO_SNAPCLIENT = '/opt/snapclient-0.35'
export const BINARIO_SNAPCLIENT = `${PREFISSO_SNAPCLIENT}/usr/bin/snapclient`

// ------------------------------------------------------------- eseguire

/**
 * ⚠️ **La shell di login parla prima di noi, e il banco la sentiva.**
 *
 * `sede.esegui` passa da `bash -lc`, cioe una shell di **login**: prima del
 * nostro comando sorgente `/etc/profile` e `~/.profile`, e li dentro un PC vero
 * ha spesso qualcosa che stampa -- un saluto, il conto degli aggiornamenti, il
 * banner di uno strumento che si e installato da se. Quella roba finisce in
 * testa all'uscita, e il banco l'uscita la usa come numero e come booleano:
 * `Number(await nellaSede(CONTA))` diventa `NaN`, e un `test -d X && echo ok`
 * diventa vero anche quando la cartella non c'e.
 *
 * Misurato dentro la distro con due `echo` aggiunti al profilo: il controllo
 * degli attrezzi riportava «mancano: ciao dal profilo». Dentro la distro
 * dedicata dell'ADR 0003 il profilo non stampa mai niente, ed e per questo che
 * su Windows non si era mai visto.
 *
 * Il rimedio sta **qui e una volta sola**, non nei sette script sopra: si fa
 * stampare una marca prima del comando, e si tiene solo cio che viene dopo. Il
 * profilo parla all'avvio della shell, cioe prima della marca, per costruzione.
 */
const MARCA_INIZIO = 'BANCO-SEDE-INIZIO'

function conMarca(comando: string): string {
  return `echo ${MARCA_INIZIO}\n${comando}`
}

/** Tutto cio che viene dopo la marca: prima c'e solo cio che ha detto il profilo. */
function dopoLaMarca(uscita: string): string {
  const righe = uscita.split(/\r?\n/)
  const i = righe.findIndex((r) => r.trim() === MARCA_INIZIO)
  // Marca assente: non e mai successo, e inghiottire tutto sarebbe peggio che
  // restituire un'uscita sporca -- almeno cosi si vede cosa e arrivato.
  return (i < 0 ? righe : righe.slice(i + 1)).join('\n').trim()
}

/**
 * Un comando dentro la Sede. Torna l'uscita ripulita e **non solleva**: e per
 * le domande di cui anche il fallimento e una risposta ("quanti ne sono vivi?").
 */
export async function nellaSede(comando: string, opzioni: OpzioniEsecuzione = {}): Promise<string> {
  return dopoLaMarca((await sede.esegui(conMarca(comando), opzioni)).uscita)
}

/**
 * Come sopra, ma un esito diverso da zero ferma lo script.
 *
 * Serve perche `sede.esegui` non solleva mai -- giusto per il motore, che deve
 * scrivere nel Diario e proseguire -- mentre il banco che ha fallito a scaricare
 * snapserver deve fermarsi li, non arrivare a `ldd` e lamentarsi di un binario
 * che non ha mai avuto.
 */
export async function nellaSedeOFallisci(
  comando: string,
  opzioni: OpzioniEsecuzione = {},
): Promise<string> {
  const r = await sede.esegui(conMarca(comando), opzioni)
  if (r.stato !== 0) {
    // Qui l'uscita si riporta **grezza**, marca compresa: e una diagnosi, e cio
    // che ha detto il profilo puo essere proprio la spiegazione del guasto.
    throw new Error(
      `comando fallito nella Sede (${sede.descrizione}), esito ${r.stato}:\n` +
        `${comando}\n${r.uscita}\n${r.errore}`,
    )
  }
  return dopoLaMarca(r.uscita)
}

// ---------------------------------------------------------- l'indirizzo

let indirizzoRicordato: string | null = null

/**
 * L'indirizzo a cui il banco apre le sorgenti TCP.
 *
 * **Non ha un ripiego su `127.0.0.1`, e non e una dimenticanza.** Su Windows il
 * loopback e la trappola dell'ADR 0010: gli inoltri che WSL crea sopravvivono al
 * processo che ascoltava, quindi contro un server morto la `connect()` riesce lo
 * stesso, i byte partono, non li legge nessuno -- e il banco stamperebbe un
 * Flusso perfetto dentro un fantasma. Meglio fermarsi che misurare una bugia.
 * Su Linux `SedeLocale` risponde `127.0.0.1` e li e la risposta giusta: nessun
 * WSL, nessun inoltro, e snapserver ascolta su `0.0.0.0` che il loopback lo
 * contiene.
 *
 * `HOST_FLUSSI` resta e vince su tutto: e la via per puntare il banco a un
 * server su un'altra macchina.
 */
export async function indirizzoFlussi(): Promise<string> {
  const forzato = process.env['HOST_FLUSSI']
  if (forzato) return forzato
  if (indirizzoRicordato) return indirizzoRicordato
  const ip = await sede.indirizzoFlussi()
  if (!ip) {
    throw new Error(
      `non riesco a leggere l'indirizzo della Sede (${sede.descrizione}). ` +
        'Il banco non ripiega su 127.0.0.1: contro un server spento la connessione ' +
        "riuscirebbe lo stesso (ADR 0010) e la misura sarebbe falsa. Accendi la Sede, " +
        'oppure passa HOST_FLUSSI=<indirizzo> a mano.',
    )
  }
  indirizzoRicordato = ip
  return ip
}

// -------------------------------------------------------------- i privilegi

let prefissoRicordato: string | null = null

/**
 * Cosa anteporre a un comando che deve scrivere in `/opt` dentro la Sede.
 *
 * Su Windows: niente. `SedeWsl.esegui` entra gia con `-u root`, e la distro e
 * dedicata a Regia (ADR 0003).
 *
 * Su Linux la Sede e il PC dell'Operatore e Regia gira come l'utente che ha
 * fatto login: `/opt` non e suo. Si e scelto **`sudo` verso `/opt`** invece di
 * estrarre sotto `~/.local` con `REGIA_SNAPSERVER`, e la ragione non e il gusto:
 * `sede.ts` cerca `REGIA_SNAPSERVER` -> `/opt/snapserver-0.35/...` -> PATH, e la
 * variabile d'ambiente la vedrebbe **solo** un Regia lanciato dallo stesso
 * terminale che ha preparato il banco. Chi prepara il banco e poi avvia Regia da
 * un'icona si troverebbe il banco funzionante e il server audio `spento`, senza
 * un errore che lo spieghi -- esattamente la classe di guasto silenzioso che
 * questo progetto passa il tempo a togliere di mezzo. `/opt/snapserver-0.35` e
 * gia il secondo posto in cui `sede.ts` guarda, e non chiede configurazione a
 * nessuno. Il prezzo e una password, una volta, mentre si prepara il banco.
 *
 * La password si chiede **qui**, con `stdio: 'inherit'`: `sudo` legge da
 * `/dev/tty`, che le pipe di `eseguiProcesso` non trasportano, e chiesta di la
 * sembrerebbe un blocco senza ragione. Si chiede prima di scaricare, cosi chi
 * non puo dare `sudo` lo scopre subito e non dopo centotrenta megabyte.
 *
 * Il prefisso che torna e `sudo -n`, non `sudo`: se per qualunque motivo la
 * credenziale appena presa non valesse dentro la Sede (`tty_tickets` la lega al
 * terminale di controllo), `-n` fa fallire subito con un messaggio, invece di
 * mettersi ad aspettare una password su un terminale che nessuno sta guardando.
 *
 * ⚠️ Non provato: questa macchina e Windows, il ramo `locale` e ragionato.
 */
export function prefissoRoot(): string {
  if (prefissoRicordato !== null) return prefissoRicordato
  if (DENTRO_WSL) return (prefissoRicordato = '')
  if (process.getuid?.() === 0) return (prefissoRicordato = '')

  console.log('Per estrarre in /opt serve `sudo`: la password e quella del tuo utente.')
  const chiesta = spawnSync('sudo', ['-v'], { stdio: 'inherit' })
  const valida = chiesta.error ? null : spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' })
  if (valida === null || valida.status !== 0) {
    throw new Error(
      'senza `sudo` non posso scrivere in /opt.\n' +
        'Due strade: rifai con un utente che possa dare sudo, oppure estrai snapserver ' +
        'dove vuoi tu e indica il binario a Regia con REGIA_SNAPSERVER=/percorso/snapserver ' +
        '-- ricordando che quella variabile deve esserci anche quando Regia parte, ' +
        "non solo quando si prepara il banco.",
    )
  }
  return (prefissoRicordato = 'sudo -n ')
}

// ------------------------------------------------------- i testi di aiuto

/**
 * Come si scrive, a mano, un comando da dare alla Sede.
 *
 * Gli script chiudono stampando le istruzioni per il passo successivo, e quelle
 * istruzioni su Linux sono un'altra cosa: niente `wsl.exe`, niente `-u root`.
 * Stamparle sbagliate e peggio che non stamparle -- chi le copia perde mezz'ora.
 */
export function comeSiScrive(comando: string): string {
  return DENTRO_WSL ? `wsl -d ${DISTRO} -u root -e bash -lc '${comando}'` : comando
}

/** Come ci si porta dentro un file, a mano: `cat >` di la, un redirect di qua. */
export function comeSiScriveUnFile(percorso: string, sorgente: string): string {
  return DENTRO_WSL
    ? `wsl -d ${DISTRO} -u root -e bash -lc 'cat > ${percorso}' < ${sorgente}`
    : `cp ${sorgente} ${percorso}`
}
