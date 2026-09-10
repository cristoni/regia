/**
 * Mette ffmpeg in `vendor/ffmpeg/`, da dove l'app impacchettata se lo porta via.
 *
 *   npm run ffmpeg:prendi
 *
 * Esiste perché il binario pesa più di 130 MB e non sta in git: senza questo
 * script il modo di rifare la build vivrebbe solo nella memoria di chi l'ha fatta
 * la prima volta, che è lo stesso motivo per cui esiste `banco/prepara.ts`.
 *
 * ⚠️ **Si prende la build LGPL, non la GPL, e non è indifferente.** Il §267 del
 * documento di progetto chiede di rispettare gli obblighi di licenza, e quelli
 * della LGPL si soddisfano spedendo la licenza accanto al binario -- che è
 * quello che fa `extraResources` in `electron-builder.yml`. Con una build GPL
 * l'obbligo si estenderebbe all'offerta scritta dei sorgenti.
 *
 * ⚠️ E si prende un binario **in bundle** invece di affidarsi al PATH per la
 * ragione scritta in cima a `src/engine/media/ffmpeg.ts`: l'`ffmpeg` del PATH su
 * una macchina qualsiasi può essere lo shim Chocolatey da 26 KB, e ucciderlo
 * lascia orfano il vero ffmpeg -- cioè una registrazione che continua a scrivere
 * su un file che Regia crede chiuso.
 *
 * ⚠️ **Si prende il binario della piattaforma che esegue lo script.** Non è
 * pigrizia: `extraResources` copia `vendor/ffmpeg` *intera* dentro il pacchetto,
 * e `trovaFfmpeg()` cerca `ffmpeg.exe` su Windows e `ffmpeg` altrove.
 *
 * Il modo di sbagliare non è lanciare `npm run dist:linux` da Windows -- quella
 * build non parte proprio, perché lì electron-builder non ha né fpm né
 * `mksquashfs` (in `electron-builder.yml` c'è scritto dove l'ho letto). È più
 * insidioso: portarsi l'albero su una macchina Linux con `vendor/ffmpeg` già
 * dentro, fare la build senza rieseguire questo script, e sfornare un AppImage in
 * cui l'unico ffmpeg è un `.exe`. Regia non lo troverebbe e ripiegherebbe sul
 * PATH, cioè esattamente sul processo orfano del paragrafo sopra. Il pacchetto
 * Linux si costruisce su Linux, e prima ci si esegue questo script -- che scarica
 * il binario giusto ma non fa pulizia: quello dell'altra piattaforma resta lì e
 * si porta nel pacchetto come peso morto.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const radice = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cartella = path.join(radice, 'vendor', 'ffmpeg')

/** Una build di BtbN: come si chiama, come è impacchettata, cosa ne esce. */
interface Compilazione {
  /** Nome della release: è anche il nome della cartella dentro l'archivio. */
  readonly nome: string
  readonly estensione: 'zip' | 'tar.xz'
  /** Il nome del binario lo decide `media/ffmpeg.ts`; qui ci si adegua a lui. */
  readonly binario: string
  /** Solo per il messaggio a chi aspetta. Dai `Content-Length`, il 2026-09-10. */
  readonly pesoMb: number
}

function compilazionePer(piattaforma: typeof process.platform): Compilazione {
  if (piattaforma === 'win32')
    return {
      nome: 'ffmpeg-master-latest-win64-lgpl',
      estensione: 'zip',
      binario: 'ffmpeg.exe',
      pesoMb: 164,
    }
  if (piattaforma === 'linux')
    return {
      nome: 'ffmpeg-master-latest-linux64-lgpl',
      estensione: 'tar.xz',
      binario: 'ffmpeg',
      pesoMb: 132,
    }
  // BtbN pubblica solo win64 e linux64. Lasciar cadere macOS nel ramo Windows
  // scaricherebbe un `.exe` da mettere in un pacchetto che non lo può eseguire:
  // meglio fermarsi qui, dove il perché è ancora leggibile.
  throw new Error(
    `BtbN non pubblica build per ${piattaforma}: esistono solo win64 e linux64.\n` +
      `Metti a mano un ffmpeg LGPL, con la sua licenza, in ${cartella}.`,
  )
}

const quale = compilazionePer(process.platform)
const binario = path.join(cartella, quale.binario)
const URL_ARCHIVIO = `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${quale.nome}.${quale.estensione}`

/**
 * Sul ramo Linux si tirano fuori **solo** i due file che servono. L'archivio
 * porta anche ffprobe -- 142 MB che Regia non lancia mai -- e la documentazione
 * HTML per intero: scompattare tutto vorrebbe dire scrivere e poi buttare
 * trecento MB nella cartella temporanea. Se BtbN cambia il nome della cartella
 * interna, `tar` esce diverso da zero e lo si scopre qui, non a valle.
 * `Expand-Archive` non sa scegliere i membri, quindi sul ramo Windows si continua
 * a scompattare tutto, com'è sempre stato.
 */
function scompatta(archivio: string, dentro: string): void {
  const modo =
    quale.estensione === 'zip'
      ? {
          comando: 'powershell',
          argomenti: [
            '-NoProfile',
            '-Command',
            `Expand-Archive -Path "${archivio}" -DestinationPath "${dentro}" -Force`,
          ],
        }
      : {
          comando: 'tar',
          argomenti: [
            '-xJf',
            archivio,
            '-C',
            dentro,
            `${quale.nome}/bin/${quale.binario}`,
            `${quale.nome}/LICENSE.txt`,
          ],
        }

  const r = spawnSync(modo.comando, modo.argomenti, { windowsHide: true, encoding: 'utf8' })
  if (r.error) throw new Error(`estrazione fallita, manca \`${modo.comando}\`? (${r.error.message})`)
  if (r.status !== 0)
    throw new Error(
      `estrazione fallita: ${(r.stderr ?? '').trim()}` +
        (modo.comando === 'tar' ? '\n(un .tar.xz vuole `xz`: su una distro spoglia può mancare)' : ''),
    )
}

/**
 * Mette il bit di esecuzione e poi controlla che il binario si esegua davvero,
 * e le due cose stanno insieme perché nessuna delle due basta da sola.
 *
 * ⚠️ I permessi, messi a mano, e non per superstizione. Nell'archivio di BtbN il
 * binario è `-rwxr-xr-x`, ma `tar` ci applica la umask di chi estrae: misurato
 * nella distro il 2026-09-10, con `umask 077` addosso ne esce `-rwx------`.
 * Dentro un `.deb` scompattato da root sarebbe un ffmpeg che solo root può
 * eseguire, e Regia gira da utente. Nemmeno `copyFile` rimedia: dà alla
 * destinazione il modo della sorgente **solo quando la destinazione non c'è
 * già** -- alla seconda passata il file esiste, viene troncato, e si tiene il
 * modo di prima. E il bit di esecuzione si perde anche a monte, in un checkout su
 * una condivisione Windows o in un archivio rifatto. `chmod` invece la umask non
 * la guarda. Su Windows la riga non fa danni: là tocca solo il bit di sola
 * lettura.
 *
 * La prova serve perché il `chmod` sia servito davvero e non sia solo un
 * commento: senza permesso di esecuzione `spawnSync` non solleva, torna
 * `status: null` e un `error` EACCES. Quando manca, il guasto non si vede
 * adesso: si vede al primo `spawn` di ffmpeg, cioè alla prima registrazione,
 * mesi dopo, con un EACCES che nessuno collega a questo script. La prova prende
 * anche il caso vicino, il binario rovinato: misurato il 2026-09-10 su Windows
 * mettendo un file di testo al posto di `ffmpeg.exe`, `spawnSync` torna un
 * `error` `UNKNOWN` e lo script esce con 1 invece di dire «gia presente».
 *
 * Torna la prima riga di `ffmpeg -version`, che è quello che si vuole stampare.
 */
async function assicuraEseguibile(): Promise<string> {
  // Un `chmod` che fallisce non è ancora un guasto: il binario può essere di un
  // altro utente -- i permessi non si toccano, ma se sono già giusti si esegue
  // lo stesso -- e il verdetto lo dà la prova qui sotto, che è la cosa che
  // interessa. Il motivo si tiene da parte per dirlo insieme all'EACCES, se poi
  // arriva: senza, di quella diagnosi mancherebbe la metà.
  let chmodFallito: string | null = null
  try {
    await fs.chmod(binario, 0o755)
  } catch (errore) {
    chmodFallito = errore instanceof Error ? errore.message : String(errore)
  }

  const prova = spawnSync(binario, ['-version'], { encoding: 'utf8', windowsHide: true })
  if (prova.error)
    throw new Error(
      `${binario} non si esegue: ${prova.error.message}` +
        (chmodFallito === null ? '' : `\n(e il chmod non è riuscito: ${chmodFallito})`),
    )
  if (prova.status !== 0)
    throw new Error(`${binario} esce con ${prova.status}: ${(prova.stderr ?? '').trim()}`)
  return (prova.stdout ?? '').split(/\r?\n/)[0] ?? '?'
}

const gia = await fs
  .access(binario)
  .then(() => true)
  .catch(() => false)
if (gia) {
  // ⚠️ Anche il ramo corto passa da `assicuraEseguibile()`, e non è pignoleria:
  // il caso che il `chmod` para di più -- il bit di esecuzione perso a monte, in
  // un checkout su una condivisione Windows o in un archivio rifatto -- è
  // proprio quello in cui il binario c'è già. Prima di qui si usciva con zero
  // stampando «gia presente» senza guardare i permessi né provare a eseguirlo:
  // su quella macchina `npm run ffmpeg:prendi` diceva che andava tutto bene, e
  // il guasto si presentava mesi dopo alla prima registrazione. Costa un `chmod`
  // e un `ffmpeg -version`, cioè niente in confronto ai ~130 MB che questo ramo
  // sta evitando di riscaricare.
  console.log(`gia presente: ${await assicuraEseguibile()}\n-> ${binario}`)
  process.exit(0)
}

console.log(`scarico ${quale.nome}.${quale.estensione} (~${quale.pesoMb} MB)...`)
const risposta = await fetch(URL_ARCHIVIO)
if (!risposta.ok) throw new Error(`scaricamento fallito: HTTP ${risposta.status}`)

const temporanea = await fs.mkdtemp(path.join(radice, '.cache-ffmpeg-'))
try {
  const archivio = path.join(temporanea, `ffmpeg.${quale.estensione}`)
  await fs.writeFile(archivio, Buffer.from(await risposta.arrayBuffer()))

  console.log('estraggo...')
  scompatta(archivio, temporanea)

  await fs.mkdir(cartella, { recursive: true })
  // La licenza viaggia col binario, non dopo: separarli è il modo in cui un
  // obbligo di licenza si perde per strada.
  await fs.copyFile(path.join(temporanea, quale.nome, 'bin', quale.binario), binario)
  await fs.copyFile(path.join(temporanea, quale.nome, 'LICENSE.txt'), path.join(cartella, 'LICENSE.txt'))
} finally {
  await fs.rm(temporanea, { recursive: true, force: true })
}

// Permessi e prova stanno nella funzione perché li vuole anche il ramo «gia
// presente»: la vecchia riga qui in fondo stampava «?» uscendo con zero, cioè un
// pacchetto rotto con l'aria di uno riuscito.
console.log(`\n${await assicuraEseguibile()}\n-> ${binario}`)
