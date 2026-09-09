/**
 * La pompa del secondo ingresso.
 *
 * Quello che si prova qui e una promessa sola, ed e quella che rende sicuro
 * accendere l'audio: **il flusso verso ffmpeg non si ferma mai**. Un ingresso
 * che tace blocca ffmpeg, e ffmpeg bloccato non scrive nemmeno il video --
 * cioe l'opzione "registra anche l'audio" potrebbe far perdere la ripresa.
 *
 * Le prove parlano con una socket vera su loopback, perche e con una socket
 * vera che ffmpeg parla: un finto non direbbe niente su cio che succede quando
 * il lettore se ne va a meta.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'

import { PompaAudio } from './pompa-audio.js'

const dormi = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Fa la parte di ffmpeg: si collega e conta quello che arriva. */
async function lettore(porta: number): Promise<{
  byte: () => number
  silenziosi: () => number
  chiudi: () => void
  attendiChiusura: Promise<void>
}> {
  const s = net.connect(porta, '127.0.0.1')
  let byte = 0
  let silenziosi = 0
  s.on('data', (d: Buffer) => {
    byte += d.length
    for (const b of d) if (b === 0) silenziosi++
  })
  await new Promise<void>((ok) => s.once('connect', ok))
  return {
    byte: () => byte,
    silenziosi: () => silenziosi,
    chiudi: () => s.destroy(),
    attendiChiusura: new Promise<void>((ok) => s.once('close', () => ok())),
  }
}

describe('la pompa del secondo ingresso', () => {
  it('scrive silenzio quando il telefono non manda niente', async () => {
    const p = new PompaAudio()
    const porta = await p.apri()
    const ff = await lettore(porta)
    p.avvia()
    await dormi(600)
    await p.chiudi()
    ff.chiudi()

    // Mezzo secondo a 44100 campioni da 2 byte sono ~44 kB. Non si pretende
    // il numero esatto -- lo detta l'orologio, e i timer di Windows hanno una
    // risoluzione di 15,6 ms -- ma che sia uscito molto e tutto silenzio.
    assert.ok(ff.byte() > 20_000, `sono usciti solo ${ff.byte()} byte`)
    assert.equal(ff.silenziosi(), ff.byte(), 'doveva essere tutto silenzio')
    assert.ok(p.silenzioInventatoMs > 300, `silenzio contato: ${p.silenzioInventatoMs} ms`)
  })

  it('non inventa silenzio se i campioni arrivano', async () => {
    const p = new PompaAudio()
    const porta = await p.apri()
    const ff = await lettore(porta)
    p.avvia()
    // 44100 campioni al secondo: si versa abbondante, cosi la coda non e mai
    // vuota e la pompa non ha scuse per mettere silenzio.
    const battito = setInterval(() => p.campioni(nonZero(8820)), 50)
    await dormi(700)
    clearInterval(battito)
    await p.chiudi()
    ff.chiudi()

    assert.ok(ff.byte() > 20_000, `sono usciti solo ${ff.byte()} byte`)
    assert.equal(p.silenzioInventatoMs, 0, 'non doveva inventare niente')
  })

  it('scrive sempre un numero pari di byte, o L e R si spezzano', async () => {
    const p = new PompaAudio()
    const porta = await p.apri()
    const ff = await lettore(porta)
    p.avvia()
    await dormi(400)
    await p.chiudi()
    ff.chiudi()
    assert.equal(ff.byte() % 2, 0, `byte dispari: ${ff.byte()}`)
  })

  /**
   * E il difetto misurato che ha reso il file illeggibile: ffmpeg finisce
   * quando finiscono **tutti** i suoi ingressi, non solo lo stdin. Se questa
   * socket resta aperta, si aspetta invano e lo si ammazza -- senza `moov`.
   */
  it('staccaFfmpeg chiude davvero la socket, o il file resta senza moov', async () => {
    const p = new PompaAudio()
    const porta = await p.apri()
    const ff = await lettore(porta)
    p.avvia()
    await dormi(200)
    p.staccaFfmpeg()
    await ff.attendiChiusura
    await p.chiudi()
  })

  it('dopo una caduta accetta il ffmpeg successivo sulla stessa porta', async () => {
    const p = new PompaAudio()
    const porta = await p.apri()
    const primo = await lettore(porta)
    p.avvia()
    await dormi(200)
    p.staccaFfmpeg()
    await primo.attendiChiusura

    const secondo = await lettore(porta)
    p.avvia()
    await dormi(300)
    assert.ok(secondo.byte() > 5_000, `il secondo non ha ricevuto niente: ${secondo.byte()}`)
    await p.chiudi()
    secondo.chiudi()
  })
})

/** Campioni riconoscibili: nessun byte a zero, cosi il silenzio si distingue. */
function nonZero(quanti: number): Uint8Array {
  return new Uint8Array(quanti).fill(7)
}
