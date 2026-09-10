/**
 * La scelta del lettore dell'anteprima, senza far suonare niente.
 *
 * `lettorePer` e pura apposta: qui si collauda **quale** processo partirebbe e
 * **con quali argomenti**, che e la parte che si puo rompere in silenzio. Che
 * quei processi poi suonino davvero non lo dice nessun collaudo: i quattro
 * lettori Unix non sono mai stati eseguiti (fatti verificati), e questo file
 * non li esegue.
 *
 * Il ramo Windows e congelato riga per riga. Il lavoro su Linux ha riscritto
 * questo file, e su Windows l'anteprima *funziona* -- una regressione qui non
 * la vedrebbe nessuno finche non si preme "ascolta" sul PC della serata.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { intestazioneWav, lettorePer } from './anteprima.js'
import { progettoVuoto, type ImpostazioniAudio } from '../dominio/progetto.js'

/** Un nome ostile per davvero: apice, spazi, accenti, e un `&` da shell. */
const OSTILE = "C:\\Suoni\\l'urlo di Ada & Nonna.wav"

describe('anteprima: la scelta del lettore', () => {
  it('su Windows produce esattamente il comando di prima', () => {
    const l = lettorePer('win32', null)
    assert.ok(l, 'su Windows il lettore c e sempre: sta in .NET, non nel PATH')
    assert.equal(l.comando, 'powershell')
    assert.deepEqual(l.argomenti('C:\\Temp\\regia-anteprima-1.wav'), [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$p = New-Object Media.SoundPlayer 'C:\\Temp\\regia-anteprima-1.wav'; $p.PlaySync()",
    ])
  })

  it('su Windows non guarda nemmeno cosa c e nel PATH', () => {
    // `Media.SoundPlayer` non e un binario: cercarlo con `command -v` non ha
    // senso, e trovare `paplay` su Windows non deve cambiare niente.
    assert.equal(lettorePer('win32', 'paplay')?.comando, 'powershell')
  })

  it('altrove prende il lettore che la ricerca ha trovato, e solo quello', () => {
    for (const nome of ['pw-play', 'paplay', 'aplay', 'ffplay']) {
      assert.equal(lettorePer('linux', nome)?.comando, nome)
    }
  })

  it('non inventa un lettore quando non ne e stato trovato nessuno', () => {
    // Il `null` porta al messaggio che dice cosa installare: se qui uscisse un
    // lettore a caso, si proverebbe a eseguire un binario che non c e.
    assert.equal(lettorePer('linux', null), null)
    assert.equal(lettorePer('linux', ''), null)
    assert.equal(lettorePer('darwin', 'afplay'), null)
  })

  it('mette gli argomenti fissi prima del percorso, mai dopo', () => {
    // `-autoexit` dopo il file sarebbe un'opzione di uscita per un ingresso che
    // non c e: ffplay resterebbe aperto sull'ultimo campione, cioe per sempre.
    assert.deepEqual(lettorePer('linux', 'ffplay')?.argomenti('/tmp/a.wav'), [
      '-nodisp',
      '-autoexit',
      '-loglevel',
      'error',
      '/tmp/a.wav',
    ])
    assert.deepEqual(lettorePer('linux', 'aplay')?.argomenti('/tmp/a.wav'), ['-q', '/tmp/a.wav'])
    assert.deepEqual(lettorePer('linux', 'paplay')?.argomenti('/tmp/a.wav'), ['/tmp/a.wav'])
  })
})

describe('anteprima: un nome ostile resta un nome', () => {
  it('sui lettori Unix il percorso e un argomento suo, intatto', () => {
    // Niente shell in mezzo: il percorso arriva a `spawn` come un elemento
    // dell'array, quindi non c e niente da citare e niente da poter rompere.
    for (const nome of ['pw-play', 'paplay', 'aplay', 'ffplay']) {
      const argomenti = lettorePer('linux', nome)?.argomenti(OSTILE) ?? []
      assert.equal(argomenti.at(-1), OSTILE, `${nome} deve passare il percorso tale e quale`)
      assert.equal(
        argomenti.filter((a) => a === OSTILE).length,
        1,
        `${nome} deve nominare il file una volta sola`,
      )
    }
  })

  it('su Windows raddoppia gli apici, e cambia solo quelli', () => {
    // Qui il percorso **entra** in una riga di comando di PowerShell, perche
    // `Media.SoundPlayer` si costruisce, non si invoca. L'apice singolo e
    // l'unico carattere che chiude la stringa: dentro apici singoli PowerShell
    // non espande `$` e non interpreta `&`.
    const [, , , comando = ''] = lettorePer('win32', null)?.argomenti(OSTILE) ?? []
    assert.equal(
      comando,
      "$p = New-Object Media.SoundPlayer 'C:\\Suoni\\l''urlo di Ada & Nonna.wav'; $p.PlaySync()",
    )
    // Il nome resta leggibile: raddoppiando l'apice si torna al file di prima.
    const dentro = comando.slice(comando.indexOf("'") + 1, comando.lastIndexOf("'"))
    assert.equal(dentro.replace(/''/g, "'"), OSTILE)
  })

  it('sui lettori Unix un apice non diventa due', () => {
    // Il raddoppio e una cura per PowerShell e un danno altrove: `l''urlo.wav`
    // e un file che non esiste.
    assert.equal(lettorePer('linux', 'paplay')?.argomenti(OSTILE).at(-1)?.includes("''"), false)
  })
})

describe('anteprima: intestazione WAV', () => {
  const AUDIO: ImpostazioniAudio = progettoVuoto('x').audio

  it('descrive il PCM che le sta dietro, non un formato a caso', () => {
    const t = intestazioneWav(1000, AUDIO)
    assert.equal(t.byteLength, 44)
    assert.equal(t.toString('ascii', 0, 4), 'RIFF')
    assert.equal(t.readUInt32LE(4), 36 + 1000, 'RIFF conta tutto il file meno gli otto byte')
    assert.equal(t.toString('ascii', 8, 12), 'WAVE')
    assert.equal(t.readUInt16LE(20), 1, 'PCM, non compresso')
    assert.equal(t.readUInt16LE(22), AUDIO.canali)
    assert.equal(t.readUInt32LE(24), AUDIO.frequenza)
    assert.equal(t.readUInt32LE(40), 1000, 'la lunghezza dei dati e quella vera')
  })

  it('tiene insieme byte al secondo e allineamento di blocco', () => {
    // Se questi due non concordano con frequenza e canali, il lettore suona il
    // Suono alla velocita sbagliata invece di rifiutarlo: un guasto che si
    // sente e non si legge.
    const t = intestazioneWav(0, AUDIO)
    const allineamento = t.readUInt16LE(32)
    assert.equal(allineamento, AUDIO.canali * (t.readUInt16LE(34) / 8))
    assert.equal(t.readUInt32LE(28), AUDIO.frequenza * allineamento)
  })
})
