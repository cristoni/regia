/**
 * La vigilanza sull'anello degli eventi del thread principale.
 *
 * Il thread audio esiste perche i mixer sul thread principale restavano
 * indietro sotto carico (ADR 0003), ma **il ponte di rete e rimasto qui**
 * (ADR 0010): i byte che i telefoni aspettano passano dallo stesso anello che
 * fa il video, le istantanee dieci volte al secondo e ffmpeg. Se l'anello si
 * ferma mezzo secondo, il ponte si ferma mezzo secondo, e un snapclient che
 * non riceve risposta entro i suoi due secondi si scollega e si ricollega --
 * un sintomo che dall'esterno sembra un problema di rete o di telefono.
 *
 * Quindi si misura, e si dice. Non si cerca il colpevole qui: qui si stabilisce
 * soltanto se il colpevole e in casa nostra.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'

/** Oltre questo, il ritardo e abbastanza per far rinunciare un telefono. */
const SOGLIA_MS = 250
/** Non piu di una riga ogni tanto: durante un blocco lungo sarebbero decine. */
const SILENZIO_MS = 5000

export function vigilaAnello(
  suDiario: (livello: 'attenzione', testo: string) => void,
  opzioni: { readonly sogliaMs?: number; readonly cadenzaMs?: number } = {},
): () => void {
  const soglia = opzioni.sogliaMs ?? SOGLIA_MS
  const istogramma = monitorEventLoopDelay({ resolution: 20 })
  istogramma.enable()

  let ultimoDetto = 0
  const battito = setInterval(() => {
    // `max` e non la mediana: un anello che sta bene per 950 ms e fermo per 300
    // ha una mediana perfetta e ha comunque perso il telefono.
    const peggio = istogramma.max / 1e6
    const mediano = istogramma.mean / 1e6
    istogramma.reset()
    if (peggio < soglia) return
    const ora = Date.now()
    if (ora - ultimoDetto < SILENZIO_MS) return
    ultimoDetto = ora
    suDiario(
      'attenzione',
      `Il thread principale si e fermato per ${Math.round(peggio)} ms ` +
        `(media ${Math.round(mediano)} ms): in quel tempo il ponte di rete non ha ` +
        'inoltrato niente, e i telefoni possono essersi scollegati.',
    )
  }, opzioni.cadenzaMs ?? 1000)
  battito.unref?.()

  return () => {
    clearInterval(battito)
    istogramma.disable()
  }
}
