/**
 * La Sede, sulla parte che si puo provare senza avviare niente.
 *
 * Due cose contano qui, e sono tutte e due cose che se sbagliate non danno
 * errore: il cancello di versione (uno snapserver vecchio parte e ascolta
 * altrove, in silenzio) e la separazione fra l'indirizzo dei Flussi e il ponte
 * (un ponte aperto verso il loopback si collega a se stesso).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { progettoVuoto } from '../dominio/progetto.js'
import {
  SedeLocale,
  SedeWsl,
  VERSIONE_MINIMA_SNAPSERVER,
  leggiSnapserver,
  sedeDi,
  versioneTroppoVecchia,
} from './sede.js'

/** Cio che stampa davvero la ricerca, marcato com'e nel codice. */
function uscitaRicerca(percorso: string, versione: string): string {
  return `REGIA-SEDE-DOVE:${percorso}\nREGIA-SEDE-VERSIONE:${versione}`
}

describe('il cancello di versione di snapserver', () => {
  /**
   * In 0.33 la sezione `[tcp]` e diventata `[tcp-control]`. Una versione
   * precedente legge il nostro file, ignora in silenzio le sezioni che non
   * conosce, parte, e ascolta sulle porte sbagliate coi default suoi: nessun
   * errore nel log, e il guasto si scopre a meta serata.
   */
  it('rifiuta la 0.27 che l apt di Ubuntu fornisce ancora', () => {
    assert.equal(versioneTroppoVecchia('0.27.0'), true)
    assert.equal(versioneTroppoVecchia('0.31.0'), true)
    assert.equal(versioneTroppoVecchia('0.32.9'), true)
  })

  it('accetta dalla 0.33 in su, e la 0.33 esatta', () => {
    assert.equal(versioneTroppoVecchia(VERSIONE_MINIMA_SNAPSERVER), false)
    assert.equal(versioneTroppoVecchia('0.33.0'), false)
    assert.equal(versioneTroppoVecchia('0.35.0'), false)
    assert.equal(versioneTroppoVecchia('1.0.0'), false)
  })

  /**
   * Non saperlo non e sapere che e vecchia. Un binario che c'e ma non dice la
   * versione va lasciato provare: bloccarlo sarebbe rifiutare di partire per
   * una domanda a cui non si e avuta risposta.
   */
  it('non blocca quando la versione non si e potuta leggere', () => {
    assert.equal(versioneTroppoVecchia(null), false)
    assert.equal(versioneTroppoVecchia(undefined), false)
    assert.equal(versioneTroppoVecchia(''), false)
  })
})

describe('trovare snapserver in mezzo a cio che dice la shell di login', () => {
  it('legge il percorso e la versione dalle righe marcate', () => {
    const t = leggiSnapserver({
      stato: 0,
      uscita: uscitaRicerca('/opt/snapserver-0.35/usr/bin/snapserver', 'snapserver v0.35.0'),
      errore: '',
    })
    assert.deepEqual(t, {
      percorso: '/opt/snapserver-0.35/usr/bin/snapserver',
      versione: '0.35.0',
    })
  })

  /**
   * Il caso per cui esistono le marche. I comandi girano in `bash -lc`, cioe
   * una shell di **login**, che sorgente `/etc/profile` e `~/.profile`: su un
   * PC Linux di qualcuno li dentro c'e spesso un saluto, o l'avviso degli
   * aggiornamenti, o il banner di uno strumento che si e installato da se.
   * Dentro la distro dedicata dell'ADR 0003 non stampa mai niente, ed e per
   * questo che la cosa non si vedeva. Prendendo "la prima riga" come percorso,
   * Regia avrebbe provato a eseguire quel saluto.
   */
  it('non si fa ingannare da cio che stampa il profilo dell utente', () => {
    const t = leggiSnapserver({
      stato: 0,
      uscita: [
        'Ciao! 3 aggiornamenti disponibili.',
        '*** Sistema riavviato dopo un aggiornamento del kernel ***',
        uscitaRicerca('/usr/bin/snapserver', 'snapserver v0.34.0'),
        'nvm: versione 20 in uso',
      ].join('\n'),
      errore: '',
    })
    assert.deepEqual(t, { percorso: '/usr/bin/snapserver', versione: '0.34.0' })
  })

  it('non trova niente se la ricerca non ha marcato niente', () => {
    assert.equal(leggiSnapserver({ stato: 1, uscita: '', errore: '' }), null)
    // Esito zero ma nessuna marca: e uscita solo la chiacchiera del profilo.
    assert.equal(leggiSnapserver({ stato: 0, uscita: 'Ciao!', errore: '' }), null)
  })

  /**
   * Un binario che c'e ma non dichiara la versione va riportato lo stesso: il
   * Setup deve poter distinguere "manca" da "c'e ma e strano", e
   * `versioneTroppoVecchia('')` lascia passare invece di bloccare su una
   * domanda a cui non si e avuta risposta.
   */
  it('riporta il binario anche quando non dice la versione', () => {
    const t = leggiSnapserver({
      stato: 0,
      uscita: uscitaRicerca('/usr/local/bin/snapserver', 'boh'),
      errore: '',
    })
    assert.deepEqual(t, { percorso: '/usr/local/bin/snapserver', versione: '' })
    assert.equal(versioneTroppoVecchia(t?.versione), false)
  })
})

describe('la Sede locale', () => {
  /**
   * I due valori che prima erano uno solo. Su Windows coincidono; qui
   * divergono, ed e tutto il punto dell'interfaccia: le sorgenti vanno su
   * `127.0.0.1` -- giusto, non c'e nessun inoltro fantasma di WSL da temere --
   * ma il ponte non va aperto, perche snapserver ascolta gia su `0.0.0.0`.
   * Passare quel `127.0.0.1` a `Ponte.apri()` lo farebbe rifiutare da
   * `diLoopback()` e scrivere nel Diario una riga falsa.
   */
  it('manda i Flussi al loopback e non chiede nessun ponte', async () => {
    const s = new SedeLocale('/tmp/regia-collaudo')
    assert.equal(await s.indirizzoFlussi(), '127.0.0.1')
    assert.equal(s.serveIlPonte, false)
  })

  /** La Sede e la macchina stessa: c'e sempre. Cio che puo mancare e snapserver. */
  it('non e mai indisponibile: la domanda su snapserver e un altra', async () => {
    assert.equal(await new SedeLocale('/tmp/regia-collaudo').indisponibile(), null)
  })

  /**
   * `/var/lib/snapserver` va bene solo dove i comandi girano come root, cioe
   * dentro la distro dedicata. Qui Regia e l'utente che ha fatto login, e li
   * non puo scrivere: il `datadir` deve stare sotto la cartella di lavoro.
   */
  it('tiene il datadir dentro la propria cartella di lavoro', () => {
    const s = new SedeLocale('/run/user/1000/regia')
    assert.ok(
      s.datadir.startsWith('/run/user/1000/regia'),
      `il datadir e fuori dalla cartella di lavoro: ${s.datadir}`,
    )
    assert.notEqual(s.datadir, '/var/lib/snapserver')
  })
})

describe('la Sede WSL', () => {
  it('vuole il ponte, e si fa chiamare col nome della distro', () => {
    const s = new SedeWsl('Regia-Snapserver')
    assert.equal(s.serveIlPonte, true)
    assert.match(s.descrizione, /Regia-Snapserver/)
  })
})

describe('quale Sede vale su questa macchina', () => {
  /**
   * Si guarda `process.platform` e basta: non c'e una impostazione da
   * indovinare e non c'e un caso misto. Su Windows snapserver **non puo**
   * girare nativo (ADR 0002); altrove **non serve** una macchina virtuale.
   */
  it('sceglie la distro su Windows e il PC altrove', () => {
    const sede = sedeDi(progettoVuoto('C:/Video').server)
    assert.equal(sede.genere, process.platform === 'win32' ? 'wsl' : 'locale')
    // Il ponte segue la Sede, non una impostazione: e la stessa decisione.
    assert.equal(sede.serveIlPonte, process.platform === 'win32')
  })
})
