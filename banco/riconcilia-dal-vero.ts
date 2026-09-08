/**
 * Riconcilia un snapserver **vero** contro un progetto finto, e verifica che
 * converga davvero.
 *
 *   npx tsx banco/riconcilia-dal-vero.ts
 *
 * E la prova che i test puri del riconciliatore non possono dare: che le forme
 * che gli diamo in pasto siano quelle che il server produce sul serio, e che le
 * azioni che pianifica abbiano sul server l'effetto che il simulatore prevede.
 *
 * Presuppone uno snapserver acceso con le Zone Ingresso / Cantina / Soffitta e
 * qualche `snapclient` collegato. Vedi `docs/fatti-verificati.md`.
 */
import { progettoVuoto, type Altoparlante, type Zona } from '../src/engine/dominio/progetto.ts'
import { ClientRpc } from '../src/engine/snapcast/rpc.ts'
import { pianifica, type Azione, type StatoOsservato } from '../src/engine/snapcast/riconciliatore.ts'

const NOMI_ZONE = ['Ingresso', 'Cantina', 'Soffitta']

function collocazione(s: StatoOsservato): Record<string, string> {
  const r: Record<string, string> = {}
  for (const g of s.gruppi) for (const c of g.clientIds) r[c] = g.streamId
  return r
}

async function esegui(rpc: ClientRpc, a: Azione): Promise<void> {
  switch (a.tipo) {
    case 'gruppoClient': await rpc.gruppoClient(a.gruppoId, a.clientIds); break
    case 'gruppoStream': await rpc.gruppoStream(a.gruppoId, a.streamId); break
    case 'nomeClient': await rpc.nomeClient(a.clientId, a.nome); break
    case 'volumeClient': await rpc.volumeClient(a.clientId, a.percentuale, a.muto); break
    case 'latenzaClient': {
      const ottenuta = await rpc.latenzaClient(a.clientId, a.latenzaMs)
      if (ottenuta !== a.latenzaMs) console.log(`      (il server ha troncato a ${ottenuta} ms)`)
      break
    }
  }
}

const rpc = new ClientRpc()
rpc.on('notifica', (metodo: string) => console.log(`   ← notifica ${metodo}`))

await rpc.collega()
console.log('Collegato alla porta di controllo.\n')

const iniziale = await rpc.stato()
console.log(`Stream sul server: ${iniziale.streamIds.join(', ')}`)
console.log(`Client visti: ${iniziale.clienti.length}, gruppi: ${iniziale.gruppi.length}`)
console.log('Collocazione iniziale:', collocazione(iniziale), '\n')

if (iniziale.clienti.length === 0) {
  console.log('Nessun client collegato: avvia qualche snapclient e riprova.')
  await rpc.chiudi()
  process.exit(1)
}

// Progetto finto: i client si distribuiscono a giro sulle Zone vere del server.
const progetto = progettoVuoto('C:/Video')
progetto.zone = NOMI_ZONE.map(
  (nome, i): Zona => ({
    id: `z${i + 1}`, nome, colore: '#ff6600', ordine: i,
    volume: 1, sottofondoId: null, suoniAbilitati: null,
  }),
)
progetto.altoparlanti = iniziale.clienti.map(
  (c, i): Altoparlante => ({
    id: c.id,
    nome: `Cassa ${i + 1}`,
    // L'ultimo resta senza Zona: serve a provare anche i non assegnati.
    zonaId: i === iniziale.clienti.length - 1 ? null : `z${(i % NOMI_ZONE.length) + 1}`,
    volume: 0.6,
    muto: false,
    latenzaMs: 0,
    vistoIl: new Date().toISOString(),
  }),
)
console.log('Voluto:', Object.fromEntries(progetto.altoparlanti.map((a) => [a.id, a.zonaId ?? '(non assegnato)'])), '\n')

let stato = iniziale
let passata = 0
for (; passata < 8; passata++) {
  const azioni = pianifica(progetto, stato)
  if (azioni.length === 0) break
  console.log(`Passata ${passata + 1}: ${azioni.length} azioni`)
  for (const a of azioni) {
    console.log(`   ${a.tipo.padEnd(14)} ${a.perche}`)
    await esegui(rpc, a)
  }
  stato = await rpc.stato()
}

console.log(`\nConverso in ${passata} passate.`)
console.log('Collocazione finale:', collocazione(stato))

const residue = pianifica(progetto, stato)
if (residue.length > 0) {
  console.error(`\nNON CONVERGE: restano ${residue.length} azioni`)
  for (const a of residue) console.error(`   ${a.tipo}: ${a.perche}`)
  await rpc.chiudi()
  process.exit(1)
}

console.log('\nIdempotente: una seconda riconciliazione non produce nulla.')
await rpc.chiudi()
