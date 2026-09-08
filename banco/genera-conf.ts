/**
 * Stampa su stdout la `snapserver.conf` che Regia genererebbe per un progetto
 * con le Zone passate a riga di comando.
 *
 *   npx tsx banco/genera-conf.ts Ingresso Cantina Soffitta > snapserver.conf
 *
 * Serve a provare il generatore contro uno snapserver vero senza dover avviare
 * tutta Regia -- ed e anche il modo con cui la configurazione entra nella distro
 * WSL durante gli esperimenti.
 */
import { progettoVuoto, type Zona } from '../src/engine/dominio/progetto.ts'
import { generaConfigurazione } from '../src/engine/snapcast/configurazione.ts'

const nomi = process.argv.slice(2)
if (nomi.length === 0) nomi.push('Ingresso', 'Cantina', 'Soffitta')

const progetto = progettoVuoto('C:/Video/Regia')
progetto.zone = nomi.map(
  (nome, i): Zona => ({
    id: `z${i + 1}`,
    nome,
    colore: '#ff6600',
    ordine: i,
    volume: 1,
    sottofondoId: null,
    suoniAbilitati: null,
  }),
)

const c = generaConfigurazione(progetto)
process.stdout.write(c.testo)
process.stderr.write(
  `Flussi: ${c.flussi.map((f) => `${f.id}@${f.porta}`).join(', ')}\n` +
    `Porte da tenere libere: ${c.porte.join(' ')}\n`,
)
