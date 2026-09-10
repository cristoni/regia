/**
 * Aprire una cartella nel gestore file del sistema.
 *
 * Serve a una cosa sola: il pulsante "apri la cartella delle registrazioni"
 * (§3.7). Dopo l'Evento l'Operatore vuole i file, e dirgli il percorso e
 * aspettarsi che lo incolli da qualche parte e un modo peggiore di darglieli.
 *
 * Il comando cambia col sistema e non c'e un modo portabile: `explorer.exe` su
 * Windows, `open` su macOS, `xdg-open` su Linux -- che e il pezzo di
 * `xdg-utils` che smista la richiesta al gestore file davvero installato,
 * qualunque esso sia.
 *
 * ⚠️ **Il codice di uscita non si guarda, e non e pigrizia**: `explorer.exe`
 * risponde 1 anche quando riesce, quindi da lui non si impara niente.
 * L'errore di *avvio* invece si guarda, ed e un altro fatto: su Linux
 * `xdg-open` puo mancare del tutto -- su una macchina senza ambiente grafico
 * non c'e ragione che ci sia -- e un evento `error` di un processo figlio
 * senza nessuno che lo ascolta e un'eccezione non gestita, cioe un pulsante
 * che butta giu il motore nel mezzo di un Evento. Si ascolta, non si rilancia,
 * e lo si dice a chi ha premuto: un pulsante che non fa niente e non spiega
 * perche manda l'Operatore a cercare il guasto nel posto sbagliato.
 */
import { spawn } from 'node:child_process'

function comandoDiSistema(): string {
  if (process.platform === 'win32') return 'explorer.exe'
  if (process.platform === 'darwin') return 'open'
  return 'xdg-open'
}

/**
 * Apre `cartella`, che deve gia esistere. Non aspetta.
 *
 * @param suErrore Chiamato se il comando non e nemmeno partito, con una frase
 *   gia buona per il Diario. Non viene chiamato se il gestore file parte e poi
 *   si lamenta per conto suo: quello non lo sappiamo e non lo inventiamo.
 */
export function apriCartella(cartella: string, suErrore?: (motivo: string) => void): void {
  // `detached` piu `unref()`: la finestra del gestore file sopravvive a Regia,
  // e Regia non aspetta che venga chiusa per potersi chiudere lei.
  //
  // ⚠️ `stdio: 'ignore'` fa parte di quel "non aspetta", e non e ornamento:
  // `unref()` toglie dal ciclo di eventi il processo figlio, **non le sue
  // pipe**, che con lo `stdio` predefinito restano aperte finche lui vive. Su
  // Windows non si vedeva perche `explorer.exe` passa la richiesta e muore
  // subito; su Linux `xdg-open` puo lanciare un gestore file che resta aperto
  // per ore, e Regia si rifiuterebbe di chiudersi senza dire perche.
  const p = spawn(comandoDiSistema(), [cartella], {
    windowsHide: false,
    detached: true,
    stdio: 'ignore',
  })
  p.on('error', (e: NodeJS.ErrnoException) => {
    suErrore?.(
      e.code === 'ENOENT'
        ? `non riesco ad aprire la cartella: "${comandoDiSistema()}" non c'e su questo sistema` +
          (process.platform === 'linux' ? ' (lo porta il pacchetto xdg-utils)' : '') +
          `. La cartella e ${cartella}`
        : `non riesco ad aprire la cartella ${cartella}: ${e.message}`,
    )
  })
  p.unref()
}
