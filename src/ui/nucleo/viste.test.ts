/**
 * Le derivazioni dell'interfaccia, provate senza un DOM.
 *
 * E l'unico posto dell'interfaccia in cui si puo davvero sbagliare qualcosa che
 * si nota solo la sera: quale pulsante e acceso, quali Suoni sono ammessi in
 * una Zona, cosa dice la barra di stato quando le cose vanno male insieme.
 * Il codice che tocca il DOM, sopra a queste, e sottile abbastanza da non
 * avere bisogno di prove.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { Stato, SuonoVivo, ZonaViva } from '../../engine/api/protocollo'
import {
  celleVideo,
  colonneGriglia,
  daQuando,
  effettiDellaZona,
  inCorso,
  riepilogoSetup,
  salute,
  scorciatoie,
} from './viste'

function suono(id: string, extra: Partial<SuonoVivo> = {}): SuonoVivo {
  return {
    id, nome: id, colore: '#ff0000', categoria: null, durataMs: 1000,
    tastoRapido: null, pronto: true, guadagno: 1, ...extra,
  }
}

function zona(id: string, extra: Partial<ZonaViva> = {}): ZonaViva {
  return {
    id, nome: id, colore: '#112233', volume: 1, sottofondoId: null,
    effettiInCorso: [], altoparlantiCollegati: 1, altoparlantiTotali: 1,
    telecamereCollegate: 0, telecamereTotali: 0, buchiMs: 0,
    suoniAbilitati: null, flusso: id, scrittore: 'attivo', scartoMs: 200, ...extra,
  }
}

function stato(extra: Partial<Stato> = {}): Stato {
  return {
    progettoNome: 'Casa', server: 'acceso', zone: [], altoparlanti: [], telecamere: [],
    suoni: [], registrazione: { attive: 0, spazioLiberoGb: 100, sottoAvviso: false, bloccata: false, cartella: 'C:/Video' },
    audio: { bufferMs: 2000, codec: 'pcm', bandaMbit: 11.3 },
    impostazioni: {
      audio: {
        bufferMs: 2000, codec: 'pcm', frequenza: 44100, canali: 2, portaBaseFlussi: 4953,
        bloccoMs: 20, dissolvenzaMs: 15, anticipoMs: 200, idleThresholdMs: 2000,
      },
      server: { distro: 'Regia', portaControllo: 1705, portaHttp: 1780, portaFlussoClient: 1704 },
      registrazione: { cartella: 'C:/Video', minutiSegmento: 10, conAudio: false, avvisoSpazioGb: 20, bloccoSpazioGb: 5 },
    },
    ambiente: {
      wsl: 'ok', distro: 'Regia', snapserver: '0.35.0', ffmpeg: '7.1',
      porteOccupate: [], indirizzi: [], controllatoIl: null,
    },
    latenzaAttesaMs: 2200,
    avvisi: [],
    ...extra,
  }
}

describe('Suoni ammessi in una Zona', () => {
  const s = stato({ suoni: [suono('s1'), suono('s2'), suono('s3')] })

  it('null significa tutta la libreria, e non "nessuno"', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: null })).map((x) => x.id),
      ['s1', 's2', 's3'],
    )
  })

  it('un elenco vuoto e una scelta: quella Zona non ha Effetti', () => {
    assert.deepEqual(effettiDellaZona(s, zona('z1', { suoniAbilitati: [] })), [])
  })

  it('tiene l ordine della libreria, non quello dell elenco abilitati', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: ['s3', 's1'] })).map((x) => x.id),
      ['s1', 's3'],
    )
  })

  it('ignora un Suono abilitato che non esiste piu', () => {
    assert.deepEqual(
      effettiDellaZona(s, zona('z1', { suoniAbilitati: ['s1', 'sparito'] })).map((x) => x.id),
      ['s1'],
    )
  })
})

describe('il pulsante che si illumina', () => {
  it('e acceso finche l Effetto e in corso in quella Zona', () => {
    const z = zona('z1', { effettiInCorso: [{ suonoId: 's1', istanza: 3 }] })
    assert.equal(inCorso(z, 's1'), true)
    assert.equal(inCorso(z, 's2'), false)
  })

  it('resta acceso con piu istanze dello stesso Suono sovrapposte', () => {
    const z = zona('z1', {
      effettiInCorso: [
        { suonoId: 's1', istanza: 1 },
        { suonoId: 's1', istanza: 2 },
      ],
    })
    assert.equal(inCorso(z, 's1'), true)
  })
})

describe('tasti rapidi', () => {
  it('trova i doppioni invece di lasciarli scoprire premendo', () => {
    const s = stato({
      suoni: [
        suono('s1', { nome: 'Urlo', tastoRapido: 'F1' }),
        suono('s2', { nome: 'Botto', tastoRapido: 'f1' }),
        suono('s3', { nome: 'Risata', tastoRapido: 'F2' }),
      ],
    })
    const { perTasto, conflitti } = scorciatoie(s)
    assert.equal(perTasto.get('F1'), 's1')
    assert.equal(perTasto.get('F2'), 's3')
    assert.equal(conflitti.length, 1)
    assert.deepEqual(conflitti[0], { tasto: 'F1', suoni: ['Urlo', 'Botto'] })
  })
})

describe('la griglia video', () => {
  it('raggruppa per Zona nell ordine delle Zone, non in ordine alfabetico', () => {
    const s = stato({
      zone: [zona('z1', { nome: 'Ingresso' }), zona('z2', { nome: 'Cantina' })],
      telecamere: [
        telecamera('t1', 'Zeta', 'z2'),
        telecamera('t2', 'Alfa', 'z1'),
        telecamera('t3', 'Beta', null),
      ],
    })
    assert.deepEqual(
      celleVideo(s).map((c) => c.telecamera.id),
      ['t2', 't1', 't3'],
    )
    assert.equal(celleVideo(s)[2]!.zona, null)
  })

  it('sceglie le colonne come chiede il §3.6', () => {
    assert.deepEqual([1, 2, 4, 6, 9, 12].map(colonneGriglia), [1, 2, 2, 3, 3, 4])
  })
})

describe('la barra di stato', () => {
  it('dice la cosa peggiore, non la prima', () => {
    const s = stato({
      server: 'caduto',
      zone: [zona('z1', { buchiMs: 40 })],
      registrazione: { attive: 0, spazioLiberoGb: 1, sottoAvviso: true, bloccata: true, cartella: 'C:/V' },
    })
    assert.equal(salute(s).livello, 'grave')
    assert.match(salute(s).testo, /server audio/)
  })

  it('non si lamenta di un Altoparlante non assegnato: e lo stato normale', () => {
    const s = stato({
      altoparlanti: [
        { id: 'a1', nome: 'Cassa', zonaId: null, collegato: false, volume: 1, muto: false, latenzaMs: 0, indirizzo: null, vistoIl: '', inIdentificazione: false },
      ],
    })
    assert.equal(salute(s).livello, 'info')
  })

  it('segnala un Altoparlante assegnato che non c e piu', () => {
    const s = stato({
      zone: [zona('z1')],
      altoparlanti: [
        { id: 'a1', nome: 'Cucina', zonaId: 'z1', collegato: false, volume: 1, muto: false, latenzaMs: 0, indirizzo: null, vistoIl: '', inIdentificazione: false },
      ],
    })
    assert.equal(salute(s).livello, 'attenzione')
    assert.match(salute(s).testo, /Cucina/)
  })
})

describe('il riepilogo del Setup', () => {
  it('distingue una Zona solo video da una Zona vuota', () => {
    const s = stato({
      suoni: [suono('s1')],
      zone: [
        zona('z1', { nome: 'Solo video', altoparlantiTotali: 0, telecamereTotali: 2, sottofondoId: 's1' }),
        zona('z2', { nome: 'Vuota', altoparlantiTotali: 0, telecamereTotali: 0, sottofondoId: 's1' }),
      ],
    })
    const righe = riepilogoSetup(s)
    assert.ok(righe.some((r) => r.livello === 'info' && /Solo video/.test(r.testo)))
    assert.ok(righe.some((r) => r.livello === 'attenzione' && /Vuota/.test(r.testo)))
  })

  it('avvisa quando il PC ha solo il Wi-Fi: la banda e il collo di bottiglia', () => {
    const s = stato({
      suoni: [suono('s1')],
      zone: [zona('z1', { sottofondoId: 's1' })],
      ambiente: {
        wsl: 'ok', distro: 'R', snapserver: '0.35.0', ffmpeg: '7.1', porteOccupate: [],
        indirizzi: [{ interfaccia: 'Wi-Fi', ip: '192.168.1.4', senzaFili: true }],
        controllatoIl: null,
      },
    })
    assert.ok(riepilogoSetup(s).some((r) => /cavo/.test(r.testo)))
  })
})

describe('da quando non si vede', () => {
  const adesso = Date.parse('2026-09-09T21:00:00Z')
  it('dice "adesso" dentro i dieci secondi che il §8.8 concede', () => {
    assert.equal(daQuando('2026-09-09T20:59:55Z', adesso), 'adesso')
  })
  it('conta i secondi appena si supera la soglia', () => {
    assert.equal(daQuando('2026-09-09T20:59:45Z', adesso), '15 s fa')
  })
  it('regge una data che non c e', () => {
    assert.equal(daQuando(null, adesso), 'mai visto')
  })
})

function telecamera(id: string, nome: string, zonaId: string | null) {
  return {
    id, nome, zonaId, host: '192.168.1.7', porta: 4444, raggiungibile: true,
    batteria: 80, segnale: 70, inRegistrazione: false, fpsAnteprima: 20,
    vistoIl: null, https: false, utente: null, conPassword: false,
    dettagli: null, inIdentificazione: false,
  }
}
