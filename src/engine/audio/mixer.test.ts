import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ImpostazioniAudio } from '../dominio/progetto.js'
import { campioniBlocco, progettoVuoto } from '../dominio/progetto.js'
import { campionato, MixerZona, type Campionato } from './mixer.js'

// Dissolvenza corta apposta: quella vera (15 ms = 662 campioni) e i tre quarti
// di un blocco, e renderebbe illeggibili gli indici. La forma dell inviluppo non
// dipende dalla sua lunghezza.
const AUDIO: ImpostazioniAudio = { ...progettoVuoto('x').audio, dissolvenzaMs: 2 }
const PER_BLOCCO = campioniBlocco(AUDIO)
const CAMPIONI_DISSOLVENZA = Math.round((AUDIO.frequenza * AUDIO.dissolvenzaMs) / 1000)

function bloccoVuoto(): Int16Array {
  return new Int16Array(PER_BLOCCO * AUDIO.canali)
}

/** Segnale continuo: l'uscita e allora l'inviluppo moltiplicato per l'ampiezza. */
function continuo(durata: number, ampiezza: number, id = 's'): Campionato {
  const c = new Int16Array(durata * AUDIO.canali).fill(ampiezza)
  return campionato(id, c, AUDIO.canali)
}

/** Fa girare il mixer per n blocchi e restituisce il canale sinistro concatenato. */
function suona(m: MixerZona, blocchi: number): number[] {
  const b = bloccoVuoto()
  const sinistro: number[] = []
  for (let i = 0; i < blocchi; i++) {
    m.prossimoBlocco(b)
    for (let n = 0; n < PER_BLOCCO; n++) sinistro.push(b[n * AUDIO.canali]!)
  }
  return sinistro
}

describe('mixer: il Flusso non si ferma mai', () => {
  it('produce silenzio digitale quando non c e niente da suonare', () => {
    const m = new MixerZona(AUDIO)
    const u = suona(m, 10)
    assert.equal(u.length, PER_BLOCCO * 10)
    assert.ok(
      u.every((x) => x === 0),
      'un blocco senza voci deve essere silenzio, non un buco',
    )
  })

  it('continua a produrre blocchi della misura giusta dopo che tutto e finito', () => {
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(PER_BLOCCO, 8000))
    suona(m, 5)
    assert.equal(m.stato().effettiAttivi, 0)
    assert.equal(suona(m, 3).length, PER_BLOCCO * 3)
  })

  it('rifiuta un blocco di misura sbagliata invece di scrivere fuori posto', () => {
    const m = new MixerZona(AUDIO)
    assert.throws(() => m.prossimoBlocco(new Int16Array(10)), /dimensione sbagliata/)
  })
})

describe('mixer: dissolvenze', () => {
  it('apre in dissolvenza, senza salti', () => {
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(PER_BLOCCO * 4, 10000))
    const u = suona(m, 1)

    assert.ok(u[0]! < 100, `il primo campione deve partire da zero, non da ${u[0]}`)
    for (let i = 1; i < CAMPIONI_DISSOLVENZA; i++) {
      assert.ok(u[i]! >= u[i - 1]!, `l inviluppo scende a ${i}: ${u[i - 1]} -> ${u[i]}`)
    }
    assert.equal(u[CAMPIONI_DISSOLVENZA + 5], 10000)
  })

  it('chiude in dissolvenza sulla coda, cosi non fa click', () => {
    const durata = PER_BLOCCO * 2
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(durata, 10000))
    const u = suona(m, 3)

    const ultimo = u[durata - 1]!
    assert.ok(Math.abs(ultimo) < 200, `l ultimo campione deve essere quasi zero, e ${ultimo}`)
    for (let i = durata - CAMPIONI_DISSOLVENZA + 2; i < durata; i++) {
      assert.ok(u[i]! <= u[i - 1]!, `la coda risale a ${i}`)
    }
  })

  it('un Effetto piu corto della dissolvenza si sente lo stesso', () => {
    // Il caso che rompeva l inviluppo a macchina a stati: apertura e coda si
    // sovrappongono e devono incontrarsi, non annullarsi.
    const corto = Math.floor(CAMPIONI_DISSOLVENZA / 3)
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(corto, 20000))
    const u = suona(m, 1)

    const picco = Math.max(...u.slice(0, corto))
    assert.ok(picco > 0, 'un Effetto corto non deve sparire')
    assert.ok(picco < 20000, 'e nemmeno partire a tutto volume')
    assert.ok(u.slice(corto).every((x) => x === 0), 'dopo la fine deve tacere')
  })

  it('lo STOP sfuma invece di tagliare', () => {
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(PER_BLOCCO * 10, 10000))
    suona(m, 2)
    m.fermaEffetti()
    const u = suona(m, 1)

    assert.ok(u[0]! > 9000, 'lo STOP non deve azzerare di colpo')
    const zero = u.findIndex((x) => x === 0)
    assert.ok(zero > 0 && zero <= CAMPIONI_DISSOLVENZA + 2, `sfumatura troppo lunga o assente: ${zero}`)
    assert.equal(m.stato().effettiAttivi, 0)
  })
})

describe('mixer: composizione', () => {
  it('somma piu Effetti nella stessa Zona', () => {
    const m = new MixerZona(AUDIO)
    m.avviaEffetto(continuo(PER_BLOCCO * 4, 3000, 'a'))
    m.avviaEffetto(continuo(PER_BLOCCO * 4, 4000, 'b'))
    const u = suona(m, 1)
    assert.equal(u[CAMPIONI_DISSOLVENZA + 10], 7000)
    assert.equal(m.stato().effettiAttivi, 2)
  })

  it('dice QUALI Effetti stanno suonando, non solo quanti', () => {
    // Senza l'identificativo del Suono l'interfaccia non saprebbe quale
    // pulsante illuminare, e il feedback del §5.2 sarebbe impossibile.
    const m = new MixerZona(AUDIO)
    const i1 = m.avviaEffetto(continuo(PER_BLOCCO * 4, 3000, 'urlo'))
    const i2 = m.avviaEffetto(continuo(PER_BLOCCO * 4, 3000, 'botto'))
    assert.deepEqual(m.stato().effetti, [
      { suonoId: 'urlo', istanza: i1 },
      { suonoId: 'botto', istanza: i2 },
    ])

    m.fermaIstanza(i1)
    assert.deepEqual(m.stato().effetti, [{ suonoId: 'botto', istanza: i2 }])
  })

  it('taglia invece di andare in wrap-around quando la somma sfonda', () => {
    const m = new MixerZona(AUDIO)
    for (let i = 0; i < 6; i++) m.avviaEffetto(continuo(PER_BLOCCO * 2, 30000, `s${i}`))
    const u = suona(m, 1)
    const picco = Math.max(...u)
    assert.equal(picco, 32767, 'deve saturare al massimo del 16 bit')
    assert.ok(
      u.every((x) => x >= 0),
      'nessun campione deve diventare negativo: sarebbe wrap-around',
    )
  })

  it('applica il volume di Zona dentro il mix', () => {
    const m = new MixerZona(AUDIO, 0.5)
    m.avviaEffetto(continuo(PER_BLOCCO * 2, 10000))
    assert.equal(suona(m, 1)[CAMPIONI_DISSOLVENZA + 10], 5000)

    m.impostaVolume(0)
    assert.ok(suona(m, 1).every((x) => x === 0))
  })

  it('applica il guadagno del singolo Suono oltre a quello di Zona', () => {
    const m = new MixerZona(AUDIO, 0.5)
    m.avviaEffetto(continuo(PER_BLOCCO * 2, 10000), 0.5)
    assert.equal(suona(m, 1)[CAMPIONI_DISSOLVENZA + 10], 2500)
  })
})

describe('mixer: Sottofondo', () => {
  it('gira in loop oltre la propria durata, senza tacere', () => {
    const durata = Math.floor(PER_BLOCCO / 3)
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(durata, 5000))
    const u = suona(m, 1)

    // Se il loop non riavvolgesse, da `durata` in poi sarebbe silenzio.
    assert.equal(u[durata + 10], 5000)
    assert.equal(u[durata * 2 + 10], 5000)
    assert.ok(m.stato().sottofondoAttivo)
  })

  it('non ha coda: non deve sfumare a ogni giro del loop', () => {
    const durata = Math.floor(PER_BLOCCO / 3)
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(durata, 5000))
    const u = suona(m, 1)
    for (let i = durata - CAMPIONI_DISSOLVENZA; i < durata; i++) {
      assert.equal(u[i], 5000, `il loop sfuma vicino al punto di giunzione, a ${i}`)
    }
  })

  it('lo STOP di Zona ferma gli Effetti e lascia vivo il Sottofondo', () => {
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(PER_BLOCCO, 2000, 'amb'))
    m.avviaEffetto(continuo(PER_BLOCCO * 10, 8000, 'urlo'))
    suona(m, 2)

    m.fermaEffetti()
    suona(m, 1)
    const stato = m.stato()
    assert.equal(stato.effettiAttivi, 0)
    assert.equal(stato.sottofondoAttivo, true)
    assert.equal(suona(m, 1)[10], 2000, 'il Sottofondo deve continuare da solo')
  })

  it('sostituendo il Sottofondo il precedente sfuma invece di sparire', () => {
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(PER_BLOCCO * 4, 6000, 'primo'))
    suona(m, 2)
    m.impostaSottofondo(continuo(PER_BLOCCO * 4, 0, 'secondo'))
    const u = suona(m, 1)
    assert.ok(u[0]! > 5000, 'il vecchio Sottofondo non deve tagliare')
    assert.ok(u[CAMPIONI_DISSOLVENZA + 10] === 0)
  })

  it('fermaTutto lascia silenzio, non un buco nel Flusso', () => {
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(PER_BLOCCO, 3000))
    m.avviaEffetto(continuo(PER_BLOCCO * 5, 9000))
    suona(m, 2)
    m.fermaTutto()
    suona(m, 1)

    const u = suona(m, 2)
    assert.equal(u.length, PER_BLOCCO * 2)
    assert.ok(u.every((x) => x === 0))
    assert.deepEqual(m.stato(), {
      volume: 1, effetti: [], effettiAttivi: 0, sottofondoAttivo: false,
    })
  })
})

describe('mixer: tenuta nel tempo', () => {
  it('mille pressioni col mixer fermo non accumulano voci', () => {
    // E il caso del Setup col server audio ancora spento: nessuno chiama
    // prossimoBlocco, quindi nessuno pota le voci finite. Se si accumulassero,
    // sarebbe una perdita di memoria che cresce a ogni pressione di pulsante.
    const m = new MixerZona(AUDIO)
    for (let i = 0; i < 1000; i++) m.avviaEffettoEsclusivo(continuo(PER_BLOCCO * 4, 9000))
    assert.equal(m.stato().effettiAttivi, 1, 'con esclusivo ne deve restare una sola')
  })

  it('cinque minuti di Sottofondo senza perdere un colpo ne accumulare voci', () => {
    // Il criterio §8.4 chiede sessanta minuti. Qui ne facciamo cinque per non
    // rallentare la suite; il soak completo sta nel banco di prova.
    const m = new MixerZona(AUDIO)
    m.impostaSottofondo(continuo(Math.floor(AUDIO.frequenza * 1.7), 4000))
    m.avviaEffetto(continuo(PER_BLOCCO * 3, 9000))

    const blocchi = Math.round((5 * 60 * 1000) / AUDIO.bloccoMs)
    const b = bloccoVuoto()
    let sommaAssoluta = 0
    for (let i = 0; i < blocchi; i++) {
      m.prossimoBlocco(b)
      sommaAssoluta += Math.abs(b[0]!)
    }

    const stato = m.stato()
    assert.equal(stato.sottofondoAttivo, true, 'il Sottofondo si e spento da solo')
    assert.equal(stato.effettiAttivi, 0, 'un Effetto finito non e stato ripulito')
    assert.ok(sommaAssoluta > 0, 'dopo cinque minuti non usciva piu niente')
  })

  it('un Effetto fermato subito dopo l avvio non sporca lo stato', () => {
    // Una voce che non ha ancora prodotto un campione non ha niente da sfumare:
    // sparisce subito, senza lasciare un soffio ne un oggetto in coda.
    const m = new MixerZona(AUDIO)
    const istanza = m.avviaEffetto(continuo(PER_BLOCCO * 4, 10000))
    m.fermaIstanza(istanza)
    assert.equal(m.stato().effettiAttivi, 0, 'lo stato deve essere pulito prima ancora di mixare')
    assert.ok(suona(m, 2).every((x) => x === 0))
  })
})
