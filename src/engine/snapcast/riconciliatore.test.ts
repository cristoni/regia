import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto, type Altoparlante, type Progetto, type Zona } from '../dominio/progetto.js'
import { ID_NON_ASSEGNATI } from './configurazione.js'
import {
  applica,
  destinazioni,
  pianifica,
  riconcilia,
  type ClientOsservato,
  type GruppoOsservato,
  type StatoOsservato,
} from './riconciliatore.js'

function progetto(zone: string[], altoparlanti: Array<[string, string | null]>): Progetto {
  const p = progettoVuoto('C:/Video')
  p.zone = zone.map(
    (nome, i): Zona => ({
      id: `z${i + 1}`, nome, colore: '#ff6600', ordine: i,
      volume: 1, sottofondoId: null, suoniAbilitati: null,
    }),
  )
  p.altoparlanti = altoparlanti.map(
    ([id, zonaId]): Altoparlante => ({
      id, nome: id, zonaId, volume: 1, muto: false, latenzaMs: 0,
      vistoIl: '2026-09-08T00:00:00.000Z',
    }),
  )
  return p
}

function client(id: string, extra: Partial<ClientOsservato> = {}): ClientOsservato {
  return { id, connesso: true, nome: id, volumePercentuale: 100, muto: false, latenzaMs: 0, ...extra }
}

/** Lo stato in cui snapserver mette da solo dei client appena connessi. */
function appenaConnessi(ids: string[], primoStream: string): StatoOsservato {
  return {
    gruppi: ids.map((id, i): GruppoOsservato => ({ id: `g${i + 1}`, streamId: primoStream, clientIds: [id] })),
    clienti: ids.map((id) => client(id)),
    streamIds: [],
  }
}

/** Che stream sta suonando ogni client, secondo lo stato osservato. */
function collocazione(s: StatoOsservato): Record<string, string> {
  const r: Record<string, string> = {}
  for (const g of s.gruppi) for (const c of g.clientIds) r[c] = g.streamId
  return r
}

describe('riconciliatore: dove va ogni client', () => {
  it('manda ogni client nello stream della sua Zona', () => {
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z2']])
    const d = destinazioni(p, appenaConnessi(['a', 'b'], 'Ingresso'))
    assert.equal(d.get('a'), 'Ingresso')
    assert.equal(d.get('b'), 'Cantina')
  })

  it('manda nei non assegnati chi non ha Zona', () => {
    const p = progetto(['Ingresso'], [['a', null]])
    assert.equal(destinazioni(p, appenaConnessi(['a'], 'Ingresso')).get('a'), ID_NON_ASSEGNATI)
  })

  it('manda nei non assegnati chi punta a una Zona sparita, invece di perderlo', () => {
    // Succede eliminando una Zona mentre un telefono e scollegato.
    const p = progetto(['Ingresso'], [['a', 'z-sparita']])
    assert.equal(destinazioni(p, appenaConnessi(['a'], 'Ingresso')).get('a'), ID_NON_ASSEGNATI)
  })

  it('conosce anche i client che il progetto non ha mai visto', () => {
    // Un telefono nuovo che si presenta a meta Setup: il progetto non lo
    // conosce, ma deve comunque finire da qualche parte.
    const p = progetto(['Ingresso'], [])
    assert.equal(destinazioni(p, appenaConnessi(['nuovo'], 'Ingresso')).get('nuovo'), ID_NON_ASSEGNATI)
  })
})

describe('riconciliatore: il caso normale del Setup', () => {
  it('consolida tre client sparsi nelle loro due Zone', () => {
    // Snapserver mette ogni client in un gruppo suo, tutti sul PRIMO stream.
    // Il lavoro c'e sempre: non e "assegnare", e "consolidare".
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z1'], ['c', 'z2']])
    const { finale, passate } = riconcilia(p, appenaConnessi(['a', 'b', 'c'], 'Ingresso'))

    assert.deepEqual(collocazione(finale), { a: 'Ingresso', b: 'Ingresso', c: 'Cantina' })
    const gruppoAB = finale.gruppi.find((g) => g.clientIds.includes('a'))!
    assert.deepEqual([...gruppoAB.clientIds].sort(), ['a', 'b'], 'a e b devono stare nello stesso gruppo')
    assert.ok(passate <= 2, `troppe passate: ${passate}`)
  })

  it('non fa niente quando e gia tutto a posto', () => {
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z2']])
    const stato: StatoOsservato = {
      gruppi: [
        { id: 'g1', streamId: 'Ingresso', clientIds: ['a'] },
        { id: 'g2', streamId: 'Cantina', clientIds: ['b'] },
      ],
      clienti: [client('a'), client('b')],
      streamIds: [],
    }
    assert.deepEqual(pianifica(p, stato), [])
  })

  it('e idempotente: dopo aver riconciliato, non resta niente da fare', () => {
    const p = progetto(['Ingresso', 'Cantina', 'Soffitta'],
      [['a', 'z1'], ['b', 'z2'], ['c', 'z3'], ['d', 'z1'], ['e', null]])
    const { finale } = riconcilia(p, appenaConnessi(['a', 'b', 'c', 'd', 'e'], 'Ingresso'))
    assert.deepEqual(pianifica(p, finale), [], 'una seconda riconciliazione deve essere a vuoto')
  })

  it('e deterministico: due esecuzioni sullo stesso stato danno lo stesso piano', () => {
    const p = progetto(['A', 'B'], [['x', 'z1'], ['y', 'z2'], ['z', 'z1']])
    const stato = appenaConnessi(['x', 'y', 'z'], 'A')
    assert.deepEqual(pianifica(p, stato), pianifica(p, stato))
  })
})

describe('riconciliatore: le stranezze di Snapcast', () => {
  it('non tocca lo stream di un gruppo che sta gia bene', () => {
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z1']])
    const stato: StatoOsservato = {
      gruppi: [
        { id: 'g1', streamId: 'Ingresso', clientIds: ['a'] },
        { id: 'g2', streamId: 'Cantina', clientIds: ['b'] },
      ],
      clienti: [client('a'), client('b')],
      streamIds: [],
    }
    const azioni = pianifica(p, stato)
    // Deve adottare g1, che punta gia a Ingresso, e portarci dentro b.
    assert.equal(azioni.filter((x) => x.tipo === 'gruppoStream').length, 0)
    assert.deepEqual(
      azioni.filter((x) => x.tipo === 'gruppoClient'),
      [{ tipo: 'gruppoClient', gruppoId: 'g1', clientIds: ['a', 'b'], perche: azioni[0]!.perche }],
    )
  })

  it('converge anche quando togliere un client crea un gruppo nuovo', () => {
    // b esce da un gruppo dominato da client di un altro stream: snapserver
    // gli crea un gruppo nuovo, con un id che si scopre solo alla passata dopo.
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z2'], ['c', 'z1']])
    const stato: StatoOsservato = {
      gruppi: [{ id: 'g1', streamId: 'Ingresso', clientIds: ['a', 'b', 'c'] }],
      clienti: [client('a'), client('b'), client('c')],
      streamIds: [],
    }
    const { finale, passate } = riconcilia(p, stato)
    assert.deepEqual(collocazione(finale), { a: 'Ingresso', b: 'Cantina', c: 'Ingresso' })
    assert.ok(passate >= 2, 'questo caso richiede piu di una passata, per costruzione')
  })

  it('il gruppo rimasto vuoto sparisce, e la riconciliazione lo sa', () => {
    const p = progetto(['Ingresso'], [['a', 'z1'], ['b', 'z1']])
    const stato: StatoOsservato = {
      gruppi: [
        { id: 'g1', streamId: 'Ingresso', clientIds: ['a'] },
        { id: 'g2', streamId: 'Ingresso', clientIds: ['b'] },
      ],
      clienti: [client('a'), client('b')],
      streamIds: [],
    }
    const { finale } = riconcilia(p, stato)
    assert.equal(finale.gruppi.length, 1, 'il gruppo svuotato doveva sparire')
    assert.deepEqual([...finale.gruppi[0]!.clientIds].sort(), ['a', 'b'])
  })

  it('sistema anche i client scollegati, cosi al ritorno sono gia a posto', () => {
    // E il criterio §8.4: un telefono riavviato torna nella sua Zona da solo.
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z2']])
    const stato: StatoOsservato = {
      gruppi: [{ id: 'g1', streamId: 'Ingresso', clientIds: ['a'] }],
      clienti: [client('a', { connesso: false })],
      streamIds: [],
    }
    const { finale } = riconcilia(p, stato)
    assert.deepEqual(collocazione(finale), { a: 'Cantina' })
  })
})

describe('riconciliatore: la configurazione dei client', () => {
  it('corregge nome, volume, muto e latenza', () => {
    const p = progetto(['Ingresso'], [['a', 'z1']])
    p.altoparlanti[0]!.nome = 'Cassa cucina'
    p.altoparlanti[0]!.volume = 0.4
    p.altoparlanti[0]!.muto = true
    p.altoparlanti[0]!.latenzaMs = 150

    const stato: StatoOsservato = {
      gruppi: [{ id: 'g1', streamId: 'Ingresso', clientIds: ['a'] }],
      clienti: [client('a', { nome: 'vecchio', volumePercentuale: 100, muto: false, latenzaMs: 0 })],
      streamIds: [],
    }
    const azioni = pianifica(p, stato)
    assert.deepEqual(
      azioni.map((a) => a.tipo).sort(),
      ['latenzaClient', 'nomeClient', 'volumeClient'],
    )
    const vol = azioni.find((a) => a.tipo === 'volumeClient')!
    assert.equal(vol.tipo === 'volumeClient' && vol.percentuale, 40)
    assert.equal(vol.tipo === 'volumeClient' && vol.muto, true)
  })

  it('non richiede la stessa latenza per sempre quando il server la tronca', () => {
    // Il server tronca al buffer, in silenzio: chiesti 9999, risponde 2000. Se
    // si confrontasse contro il valore chiesto, ogni passata rifarebbe la stessa
    // richiesta, per tutta la serata.
    const p = progetto(['Ingresso'], [['a', 'z1']])
    p.altoparlanti[0]!.latenzaMs = 9999
    const stato: StatoOsservato = {
      gruppi: [{ id: 'g1', streamId: 'Ingresso', clientIds: ['a'] }],
      clienti: [client('a', { latenzaMs: 2000 })],
      streamIds: [],
    }
    assert.deepEqual(pianifica(p, stato), [], `buffer ${p.audio.bufferMs}: 9999 vale 2000`)
  })

  it('ignora i client che il progetto non conosce, invece di ribattezzarli', () => {
    const p = progetto(['Ingresso'], [])
    const stato: StatoOsservato = {
      gruppi: [{ id: 'g1', streamId: ID_NON_ASSEGNATI, clientIds: ['sconosciuto'] }],
      clienti: [client('sconosciuto', { nome: 'Telefono di Marco' })],
      streamIds: [],
    }
    assert.deepEqual(pianifica(p, stato), [])
  })
})

describe('riconciliatore: casi limite', () => {
  it('regge un server senza nessun client', () => {
    const p = progetto(['Ingresso'], [])
    assert.deepEqual(pianifica(p, { gruppi: [], clienti: [], streamIds: [] }), [])
  })

  it('regge un progetto senza nessuna Zona: tutti nei non assegnati', () => {
    const p = progetto([], [['a', null], ['b', null]])
    const { finale } = riconcilia(p, appenaConnessi(['a', 'b'], ID_NON_ASSEGNATI))
    assert.deepEqual(collocazione(finale), { a: ID_NON_ASSEGNATI, b: ID_NON_ASSEGNATI })
  })

  it('converge con otto client sparsi su quattro Zone', () => {
    const p = progetto(
      ['A', 'B', 'C', 'D'],
      [['c1','z1'],['c2','z1'],['c3','z2'],['c4','z2'],['c5','z3'],['c6','z4'],['c7',null],['c8','z1']],
    )
    const { finale, passate } = riconcilia(p, appenaConnessi(
      ['c1','c2','c3','c4','c5','c6','c7','c8'], 'A',
    ))
    assert.deepEqual(collocazione(finale), {
      c1: 'A', c2: 'A', c8: 'A', c3: 'B', c4: 'B', c5: 'C', c6: 'D', c7: ID_NON_ASSEGNATI,
    })
    assert.ok(passate <= 3, `troppe passate per otto client: ${passate}`)
    assert.deepEqual(pianifica(p, finale), [])
  })

  it('spostare un client da una Zona all altra e una passata sola', () => {
    const p = progetto(['Ingresso', 'Cantina'], [['a', 'z1'], ['b', 'z1']])
    const { finale } = riconcilia(p, appenaConnessi(['a', 'b'], 'Ingresso'))

    // L Operatore trascina b in Cantina.
    p.altoparlanti[1]!.zonaId = 'z2'
    const azioni = pianifica(p, finale)
    assert.ok(azioni.length > 0)
    const dopo = applica(finale, azioni)
    assert.deepEqual(collocazione(dopo), { a: 'Ingresso', b: 'Cantina' })
  })
})
