/**
 * Regia senza finestra.
 *
 *   npx tsx src/engine/avvia.ts [--porta 7333] [--rete] [--dati C:\Regia]
 *
 * Esiste perche il motore e headless per davvero (ADR 0004): la finestra di
 * Electron e "un browser dedicato" che apre questo indirizzo, e se un giorno
 * sparisse Regia continuerebbe a funzionare con un browser puntato sulla stessa
 * porta. Questo file e la prova che quella frase non e un modo di dire.
 *
 * Serve anche per il collaudo -- si pilota il motore da script mentre lo si
 * guarda dall'interfaccia vera -- e per la Fase 3, dove il tablet e un secondo
 * client identico: `--rete` fa ascoltare su tutte le interfacce invece che solo
 * su loopback.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { avviaMotore } from './index.js'

const argomenti = process.argv.slice(2)
const valore = (nome: string): string | undefined => {
  const i = argomenti.indexOf(`--${nome}`)
  return i >= 0 ? argomenti[i + 1] : undefined
}

const qui = path.dirname(fileURLToPath(import.meta.url))
const cartellaUi = [
  path.resolve(qui, '../../dist/ui'),
  path.resolve(qui, '../../../dist/ui'),
  path.resolve(process.cwd(), 'dist/ui'),
].find((c) => fs.existsSync(path.join(c, 'index.html')))

if (!cartellaUi) {
  console.error('Interfaccia non compilata: esegui prima "npm run build:ui".')
}

const porta = Number(valore('porta') ?? 7333)

const motore = await avviaMotore({
  ...(valore('dati') === undefined ? {} : { cartellaDati: valore('dati')! }),
  ...(cartellaUi === undefined ? {} : { cartellaUi }),
  servitore: {
    porta,
    // Il §6 dice "sicurezza minima, ambiente chiuso", ma esporre di default il
    // controllo dell'audio di tutta la casa a chiunque sia sul Wi-Fi degli
    // ospiti e un'altra cosa: si apre alla rete solo se lo si chiede.
    ancheDallaRete: argomenti.includes('--rete'),
  },
}).catch((e: unknown) => {
  const messaggio = (e as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? `la porta ${porta} e gia occupata: c'e gia una Regia accesa, oppure scegli --porta`
    : (e as Error).message
  console.error(`Regia non e partita: ${messaggio}`)
  process.exit(1)
})

console.log(`Regia e in ascolto su ${motore.indirizzo}`)
console.log('Ctrl+C per fermarla.')

let inChiusura = false
const chiudi = (): void => {
  if (inChiusura) return
  inChiusura = true
  console.log('\nChiusura ordinata…')
  motore
    .ferma()
    .catch((e: unknown) => console.error('chiusura non pulita:', e))
    .finally(() => process.exit(0))
}
process.on('SIGINT', chiudi)
process.on('SIGTERM', chiudi)
