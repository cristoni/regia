/**
 * Il thread audio.
 *
 * Guscio deliberatamente sottile attorno a `GestoreAudio`: qui dentro non c'e
 * nessuna decisione, solo il collegamento fra `parentPort` e il gestore. Tutto
 * cio che vale la pena collaudare sta dall'altra parte, e si collauda senza
 * avviare un thread.
 *
 * Questo thread non fa **nient'altro** che mixare e scrivere. E l'unico modo di
 * mantenere la promessa dell'ADR 0004: sei anteprime video che ridisegnano, un
 * server HTTP e una interfaccia non devono poter far arrivare tardi un blocco.
 * Misurato sul thread principale: sotto carico lo scrittore restava indietro di
 * oltre mezzo secondo e rinunciava a pezzi di Flusso.
 */
import { parentPort } from 'node:worker_threads'

import { GestoreAudio } from './gestore-audio.js'
import type { ComandoAudio, EventoAudio } from './protocollo-audio.js'

if (!parentPort) throw new Error('lavoratore.ts va eseguito come worker thread')
const porta = parentPort

const manda = (e: EventoAudio): void => porta.postMessage(e)
const gestore = new GestoreAudio({ emetti: manda })

/**
 * I comandi si eseguono in fila.
 *
 * `configura` e `ferma` sono asincroni (chiudono socket), e due comandi
 * intrecciati lascerebbero mixer di una configurazione appesi agli scrittori di
 * un'altra. La coda costa una promessa per comando e toglie un'intera classe di
 * casi limite.
 */
let coda: Promise<void> = Promise.resolve()

porta.on('message', (c: ComandoAudio) => {
  coda = coda
    .then(() => gestore.esegui(c))
    .catch((e: unknown) =>
      manda({ tipo: 'diario', livello: 'grave', testo: `comando audio fallito: ${(e as Error).message}` }),
    )
})

/**
 * Lo stato torna a intervalli regolari e non a ogni cambiamento: il mixer
 * cambia cinquanta volte al secondo, e l'interfaccia non ha bisogno di saperlo.
 */
const CADENZA_STATO_MS = 100
const battito = setInterval(() => manda({ tipo: 'stato', flussi: gestore.stato() }), CADENZA_STATO_MS)
battito.unref()

porta.on('close', () => {
  clearInterval(battito)
  void gestore.chiudi()
})

manda({ tipo: 'pronto' })
