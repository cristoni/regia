/**
 * Il supervisore, sulla parte che si puo provare senza un server acceso.
 *
 * Cio che conta qui e il **messaggio**. Il §8.1 vuole che chi fa il Setup
 * arrivi al server acceso senza usare il terminale: quando non ci arriva,
 * l'unico modo di rispettare quella promessa e che l'errore dica gia cosa
 * manca -- il nome della distro che non c'e, o il fatto che snapserver non si
 * trovi da nessuna parte. "Impossibile avviare il server" manderebbe
 * l'Operatore a cercare su internet il pomeriggio dell'evento.
 *
 * La Sede e **finta**, e non e pigrizia: con quella vera questo file
 * chiederebbe alla macchina che esegue i test se ha WSL o snapserver, e su un
 * Linux con snapserver nel PATH il primo test avvierebbe un server vero.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto } from '../dominio/progetto.js'
import type { EsitoSede, MotivoIndisponibile, Sede, SnapserverTrovato } from './sede.js'
import { FLUSSO_NON_ASSEGNATI, SupervisoreSnapcast, chiaveFlussoDi } from './supervisore.js'

/** Una Sede che non c'e, o che c'e ma e vuota. */
function sedeFinta(parti: Partial<Sede> = {}): Sede {
  const nulla: EsitoSede = { stato: 1, uscita: '', errore: '' }
  return {
    genere: 'locale',
    descrizione: 'una Sede per il collaudo',
    serveIlPonte: false,
    cartellaLavoro: '/tmp/regia-collaudo',
    datadir: '/tmp/regia-collaudo/dati',
    indisponibile: async (): Promise<MotivoIndisponibile | null> => null,
    snapserver: async (): Promise<SnapserverTrovato | null> => null,
    esegui: async (): Promise<EsitoSede> => nulla,
    scrivi: async (): Promise<EsitoSede> => nulla,
    indirizzoFlussi: async (): Promise<string | null> => null,
    ...parti,
  }
}

function supervisore(sede: Sede): SupervisoreSnapcast {
  const progetto = progettoVuoto('C:/Video')
  return new SupervisoreSnapcast({
    progetto: () => progetto,
    suDiario: () => {},
    suClientNuovo: () => {},
    suonaIdentifica: () => 600,
    suIndirizzoFlussi: () => {},
    sede: () => sede,
  })
}

describe('supervisore: quando il server non puo partire', () => {
  it('nomina la Sede che manca, con le parole che ha dato lei', async () => {
    const s = supervisore(
      sedeFinta({
        indisponibile: async () => ({
          motivo:
            'la distro "Distro-Che-Non-Esiste-Per-Il-Collaudo" non c\'e. Distro disponibili: nessuna',
          rimedio: "WSL c'e: scegli una delle distro disponibili in Impostazioni.",
        }),
      }),
    )
    try {
      await assert.rejects(
        () => s.avvia(),
        (e: Error) => {
          assert.match(e.message, /Distro-Che-Non-Esiste-Per-Il-Collaudo/)
          // Il rimedio viaggia col motivo fin dentro il messaggio d'errore: chi
          // lo legge e l'Operatore in Setup, e il §8.1 vuole che gli basti.
          assert.match(e.message, /Impostazioni/)
          return true
        },
      )
      assert.equal(s.stato(), 'non installato')
    } finally {
      await s.chiudi()
    }
  })

  /**
   * Il caso Linux: la Sede c'e per forza -- e la macchina stessa -- ma
   * snapserver puo non esserci. Sono due domande diverse e due risposte
   * diverse: "non c'e WSL" e "non c'e snapserver" mandano l'Operatore a fare
   * due cose che non si somigliano.
   */
  it('distingue "non c e la Sede" da "non c e snapserver"', async () => {
    const s = supervisore(sedeFinta({ snapserver: async () => null }))
    try {
      await assert.rejects(() => s.avvia(), /snapserver non si trova/)
      assert.equal(s.stato(), 'non installato')
    } finally {
      await s.chiudi()
    }
  })

  /**
   * Sotto la 0.33 `[tcp]` non si chiamava ancora `[tcp-control]`: snapserver
   * parte, ignora in silenzio meta della configurazione, e ascolta sulle porte
   * sbagliate. L'apt di Ubuntu 24.04 fornisce la 0.27, quindi non e un caso di
   * scuola -- e la prima cosa che andra storta a qualcuno su Linux.
   */
  it('rifiuta uno snapserver troppo vecchio invece di avviarlo storto', async () => {
    const s = supervisore(
      sedeFinta({
        snapserver: async () => ({ percorso: '/usr/bin/snapserver', versione: '0.27.0' }),
      }),
    )
    try {
      await assert.rejects(() => s.avvia(), /0\.27\.0.*troppo vecchio|troppo vecchio.*0\.27\.0/s)
      assert.equal(s.stato(), 'non installato')
    } finally {
      await s.chiudi()
    }
  })

  it('parte da spento e non finge di essere collegato', async () => {
    const s = supervisore(sedeFinta())
    assert.equal(s.stato(), 'spento')
    assert.equal(s.clienti().size, 0)
    assert.equal(s.inIdentificazione().size, 0)
    await s.chiudi()
  })

  it('rifiuta Identifica invece di far finta, se il server non c e', async () => {
    const s = supervisore(sedeFinta())
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
    const s = new SupervisoreSnapcast({
      progetto: () => progetto,
      suDiario: (livello, testo) => righe.push({ livello, testo }),
      suClientNuovo: () => {},
      suonaIdentifica: () => 600,
      suIndirizzoFlussi: () => {},
      sede: () => sedeFinta({ indisponibile: async () => ({ motivo: 'niente Sede, per il collaudo', rimedio: null }) }),
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
