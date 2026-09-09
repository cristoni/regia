/**
 * Il supervisore, sulla parte che si puo provare senza un server acceso.
 *
 * Cio che conta qui e il **messaggio**. Il §8.1 vuole che chi fa il Setup
 * arrivi al server acceso senza usare il terminale: quando non ci arriva,
 * l'unico modo di rispettare quella promessa e che l'errore dica gia cosa
 * manca -- il nome della distro che non c'e, e l'elenco di quelle che ci sono.
 * "Impossibile avviare il server" manderebbe l'Operatore a cercare su internet
 * il pomeriggio dell'evento.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto } from '../dominio/progetto.js'
import { FLUSSO_NON_ASSEGNATI, SupervisoreSnapcast, chiaveFlussoDi } from './supervisore.js'

function supervisore(distro: string): SupervisoreSnapcast {
  const progetto = progettoVuoto('C:/Video')
  progetto.server.distro = distro
  return new SupervisoreSnapcast({
    progetto: () => progetto,
    suDiario: () => {},
    suClientNuovo: () => {},
    suonaIdentifica: () => 600,
  })
}

describe('supervisore: quando il server non puo partire', () => {
  it('nomina la distro che manca, o dice che WSL non c e', async () => {
    const s = supervisore('Distro-Che-Non-Esiste-Per-Il-Collaudo')
    try {
      await assert.rejects(
        () => s.avvia(),
        (e: Error) => {
          assert.match(e.message, /Distro-Che-Non-Esiste-Per-Il-Collaudo|WSL non e installato/)
          return true
        },
      )
      assert.equal(s.stato(), 'non installato')
    } finally {
      await s.chiudi()
    }
  })

  it('parte da spento e non finge di essere collegato', async () => {
    const s = supervisore('Distro-Che-Non-Esiste-Per-Il-Collaudo')
    assert.equal(s.stato(), 'spento')
    assert.equal(s.clienti().size, 0)
    assert.equal(s.inIdentificazione().size, 0)
    await s.chiudi()
  })

  it('rifiuta Identifica invece di far finta, se il server non c e', async () => {
    const s = supervisore('Distro-Che-Non-Esiste-Per-Il-Collaudo')
    await assert.rejects(() => s.identifica('client-qualsiasi'), /non e collegato/)
    await s.chiudi()
  })
})

describe('una riconfigurazione che non riesce a ripartire', () => {
  /**
   * A chiedere questo riavvio non e stato nessuno: parte da solo dopo un cambio
   * di Zone. Se l'eccezione uscisse di qui, non la leggerebbe nessuno -- e il
   * server resterebbe spento, con le sorgenti che scrivono nel vuoto.
   */
  it('non lancia, lo scrive nel Diario e riprova', async () => {
    const righe: { livello: string; testo: string }[] = []
    const progetto = progettoVuoto('C:/Video')
    progetto.server.distro = 'Distro-Che-Non-Esiste-Per-Il-Collaudo'
    const s = new SupervisoreSnapcast({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push({ livello, testo }),
      suClientNuovo: () => {},
      suonaIdentifica: () => 600,
    })
    // `riconfigura` non fa niente se il server non risultava acceso, ed e
    // proprio il caso "era acceso e adesso non riparte" che si vuole provare.
    ;(s as unknown as { situazione: string }).situazione = 'acceso'

    await s.riconfigura()

    assert.equal(s.stato(), 'non installato')
    assert.ok(
      righe.some((r) => r.livello === 'grave' && /non e ripartito/.test(r.testo)),
      `nel Diario manca la riga grave: ${JSON.stringify(righe)}`,
    )
    await s.chiudi()
  })
})

describe('la chiave del Flusso', () => {
  /**
   * Il Flusso dei non assegnati ha bisogno di un nome per essere indirizzato,
   * e non puo essere `null`: Identifica ci scrive dentro quando il telefono non
   * sta ancora in nessuna Zona, e senza un mixer vivo la `async_read` di
   * snapserver su quella socket resta pendente per minuti.
   */
  it('da un nome anche al Flusso dei non assegnati', () => {
    assert.equal(chiaveFlussoDi('z3'), 'z3')
    assert.equal(chiaveFlussoDi(null), FLUSSO_NON_ASSEGNATI)
  })

  it('non puo collidere con un identificativo di Zona', () => {
    // Gli identificativi di Zona sono `z1`, `z2`, ...: la chiocciola li esclude.
    assert.match(FLUSSO_NON_ASSEGNATI, /^@/)
  })
})
