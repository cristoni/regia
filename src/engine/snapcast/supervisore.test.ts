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
import { createServer, type Server } from 'node:net'
import { describe, it } from 'node:test'

import { progettoVuoto, type Progetto } from '../dominio/progetto.js'
import type { EsitoSede, MotivoIndisponibile, Sede, SnapserverTrovato } from './sede.js'
import {
  FLUSSO_NON_ASSEGNATI,
  ServerEstraneo,
  SupervisoreSnapcast,
  chiaveFlussoDi,
} from './supervisore.js'

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

/**
 * Un snapserver finto sulla porta di controllo: risponde a `Server.GetStatus`
 * con gli stream che gli si dicono, e con un "ok" vuoto a tutto il resto.
 *
 * E un server vero su una porta vera, presa a caso, perche cio che si vuole
 * provare e proprio il tratto che il supervisore non puo fingere: **chi** c'e
 * dall'altra parte della 1705. Un `snapserver.service` di sistema risponde a
 * `Server.GetStatus` esattamente come il nostro, e la sola differenza sta
 * negli stream che dichiara.
 */
interface SnapserverFinto {
  readonly porta: number
  readonly metodi: string[]
  chiudi(): Promise<void>
}

function snapserverFinto(
  streamIds: readonly string[],
  clienti: readonly { id: string; nome: string }[] = [],
): Promise<SnapserverFinto> {
  const metodi: string[] = []
  const server: Server = createServer((socket) => {
    let resto = ''
    socket.on('data', (d) => {
      resto += d.toString('utf8')
      let taglio: number
      while ((taglio = resto.indexOf('\n')) >= 0) {
        const riga = resto.slice(0, taglio)
        resto = resto.slice(taglio + 1)
        if (!riga.trim()) continue
        const m = JSON.parse(riga) as { id: number; method: string }
        metodi.push(m.method)
        const result =
          m.method === 'Server.GetStatus'
            ? {
                server: {
                  groups:
                    clienti.length === 0
                      ? []
                      : [
                          {
                            id: 'g1',
                            stream_id: streamIds[0] ?? '',
                            clients: clienti.map((c) => ({
                              id: c.id,
                              connected: true,
                              host: { ip: '192.0.2.7', name: c.nome },
                              config: {
                                name: c.nome,
                                latency: 0,
                                volume: { muted: false, percent: 100 },
                              },
                            })),
                          },
                        ],
                  streams: streamIds.map((id) => ({ id })),
                },
              }
            : {}
        socket.write(JSON.stringify({ id: m.id, jsonrpc: '2.0', result }) + '\n')
      }
    })
    socket.on('error', () => {})
  })
  return new Promise((risolvi) => {
    server.listen(0, '127.0.0.1', () => {
      const porta = (server.address() as { port: number }).port
      risolvi({
        porta,
        metodi,
        chiudi: () => new Promise((ok) => server.close(() => ok())),
      })
    })
  })
}

/** Una Sede in cui "avviare snapserver" riesce sempre, e che ricorda i comandi. */
function sedeCheAvvia(opzioni: { servizioAttivo: boolean }): Sede & { comandi: string[] } {
  const comandi: string[] = []
  const ok: EsitoSede = { stato: 0, uscita: '', errore: '' }
  return {
    ...sedeFinta({
      snapserver: async () => ({ percorso: '/usr/local/bin/snapserver', versione: '0.35.0' }),
      scrivi: async () => ok,
      esegui: async (comando: string): Promise<EsitoSede> => {
        comandi.push(comando)
        if (comando.includes('pgrep')) return { ...ok, uscita: 'avviato' }
        if (comando.includes('is-active')) {
          return { ...ok, uscita: opzioni.servizioAttivo ? 'active' : 'inactive' }
        }
        if (comando.includes('already in use')) {
          return { ...ok, uscita: '[Error] (ControlServer) bind: Address already in use' }
        }
        return ok
      },
    }),
    comandi,
  }
}

function supervisoreSu(
  sede: Sede,
  porta: number,
  righe: { livello: string; testo: string }[] = [],
  nuovi: string[] = [],
): SupervisoreSnapcast {
  const progetto: Progetto = {
    ...progettoVuoto('C:/Video'),
    server: { ...progettoVuoto('C:/Video').server, portaControllo: porta },
  }
  return new SupervisoreSnapcast({
    progetto: () => progetto,
    suDiario: (livello, testo) => righe.push({ livello, testo }),
    suClientNuovo: (id) => nuovi.push(id),
    suonaIdentifica: () => 600,
    suIndirizzoFlussi: () => {},
    sede: () => sede,
  })
}

describe('supervisore: il server che risponde deve essere il nostro', () => {
  /**
   * Il caso misurato il 18 settembre 2026 su una Ubuntu vera: con
   * `snapserver.service` di sistema acceso, il nostro parte lo stesso, sordo
   * su 1704/1705/1780, e `pgrep` lo trova. Sulla porta di controllo risponde
   * quello di sistema, con il suo stream `default`. Prima di questo test il
   * supervisore si dichiarava acceso, riempiva il Diario di "Stream not
   * found" e i telefoni finivano su uno stream che nessuno scrive.
   */
  it('non si dichiara acceso su un server che non ha i nostri Flussi', async () => {
    const finto = await snapserverFinto(['default'])
    const sede = sedeCheAvvia({ servizioAttivo: true })
    const righe: { livello: string; testo: string }[] = []
    const s = supervisoreSu(sede, finto.porta, righe)
    try {
      await assert.rejects(
        () => s.avvia(),
        (e: Error) => {
          assert.match(e.message, /non e il nostro/)
          assert.match(e.message, /"Non assegnati"/)
          // Il colpevole, per nome, e il comando per toglierlo di mezzo.
          assert.match(e.message, /systemctl disable --now snapserver/)
          // La riga del log che spiega perche il nostro non ascolta.
          assert.match(e.message, /already in use/)
          return true
        },
      )
      assert.equal(s.stato(), 'caduto')
      assert.ok(
        !righe.some((r) => /Server audio acceso/.test(r.testo)),
        `il Diario dice acceso: ${JSON.stringify(righe)}`,
      )
      // Il nostro processo sordo va spento: un `pkill` **dopo** l'avvio, oltre
      // a quello di prima.
      const pkill = sede.comandi.filter((c) => c.includes('pkill'))
      assert.equal(pkill.length, 2, `pkill attesi 2, trovati ${pkill.length}`)
      // I due `pkill` sono la stessa stringa: si guarda l'ultima occorrenza.
      assert.ok(
        sede.comandi.lastIndexOf(pkill[1]!) > sede.comandi.findIndex((c) => c.includes('setsid')),
        `ordine dei comandi: ${JSON.stringify(sede.comandi.map((c) => c.split('\n')[0]))}`,
      )
      // Non si e riconciliato contro il server estraneo.
      assert.ok(!finto.metodi.includes('Group.SetStream'), finto.metodi.join(','))
    } finally {
      await s.chiudi()
      await finto.chiudi()
    }
  })

  it('adotta() rifiuta un server estraneo e non si porta dietro i suoi client', async () => {
    const finto = await snapserverFinto(['default'], [{ id: 'telefono-di-altri', nome: 'Pixel' }])
    const sede = sedeCheAvvia({ servizioAttivo: false })
    const righe: { livello: string; testo: string }[] = []
    const nuovi: string[] = []
    const s = supervisoreSu(sede, finto.porta, righe, nuovi)
    try {
      assert.equal(await s.adotta(), false)
      assert.equal(s.stato(), 'spento')
      // I client di un server che non e nostro non sono Altoparlanti: prima
      // comparivano nell'interfaccia, con l'indirizzo, a server "spento".
      assert.equal(s.clienti().size, 0)
      assert.deepEqual(nuovi, [])
      assert.ok(righe.some((r) => /non e il nostro/.test(r.testo)), JSON.stringify(righe))
      // Senza un servizio attivo non si inventa un colpevole.
      assert.ok(!righe.some((r) => /systemctl/.test(r.testo)), JSON.stringify(righe))
    } finally {
      await s.chiudi()
      await finto.chiudi()
    }
  })

  it('si dichiara acceso solo dopo aver visto i propri Flussi, sulla porta del progetto', async () => {
    const finto = await snapserverFinto(['Non assegnati'])
    const sede = sedeCheAvvia({ servizioAttivo: false })
    const righe: { livello: string; testo: string }[] = []
    const s = supervisoreSu(sede, finto.porta, righe)
    try {
      assert.notEqual(finto.porta, 1705)
      await s.avvia()
      assert.equal(s.stato(), 'acceso')
      assert.ok(righe.some((r) => /Server audio acceso/.test(r.testo)), JSON.stringify(righe))
      assert.equal(sede.comandi.filter((c) => c.includes('pkill')).length, 1)
    } finally {
      await s.chiudi()
      await finto.chiudi()
    }
  })

  it('ServerEstraneo dice cosa manca e cosa c e', () => {
    const e = new ServerEstraneo(['Ingresso', 'Non assegnati'], ['default'])
    assert.match(e.message, /"Ingresso", "Non assegnati"/)
    assert.match(e.message, /ha "default"/)
    assert.equal(e.name, 'ServerEstraneo')
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
