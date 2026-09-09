/**
 * Setup guidato: i sette passi del pomeriggio (§3.8).
 *
 * Non e una procedura che blocca -- si puo saltare al passo che serve, e si
 * puo tornarci a meta serata per rifare una prova. E un elenco di cose che a
 * fine pomeriggio si vogliono aver guardato, con accanto il pulsante che le fa.
 *
 * Due punti in cui questa schermata dice qualcosa di scomodo invece di tacere:
 *
 *  - **Il §8.1 non e raggiungibile come e scritto.** "PC pulito → server acceso
 *    in meno di 15 minuti, senza terminale" non tiene: WSL2 richiede Virtual
 *    Machine Platform, un riavvio, e la virtualizzazione abilitata da BIOS.
 *    Qui si dice cosa manca e cosa serve fare, invece di lasciare l'Operatore
 *    davanti a un errore.
 *  - **Il rilevamento automatico via mDNS non esiste.** Avahi non e compilato
 *    su Windows. L'indirizzo scritto a mano non e un ripiego: e la strada.
 */
import type { Stato } from '../../engine/api/protocollo'
import { Elenco, classe, el, testo, type Voce } from '../nucleo/dom'
import type { Contesto, Schermata } from '../nucleo/schermata'
import { ora, riepilogoSetup } from '../nucleo/viste'

export class Setup implements Schermata {
  readonly elemento = el('section', {})

  private readonly ambiente = el('div', {})
  private readonly quandoControllato = el('span', { class: 'conteggi' })
  private readonly passoAmbiente = el('div', { class: 'passo' })
  private readonly passoServer = el('div', { class: 'passo' })
  private readonly passoTelefoni = el('div', { class: 'passo' })
  private readonly passoDispositivi = el('div', { class: 'passo' })
  private readonly passoZone = el('div', { class: 'passo' })
  private readonly passoProva = el('div', { class: 'passo' })
  private readonly passoRiepilogo = el('div', { class: 'passo' })

  private readonly indirizzi = el('div', {})
  private readonly statoServer = el('div', {})
  private readonly conteggiDispositivi = el('div', {})
  private readonly conteggiZone = el('div', {})
  private readonly proveZone = el('div', { class: 'fila' })
  private readonly elencoProve: Elenco<{ id: string; nome: string; altoparlantiCollegati: number }>
  private readonly riepilogo = el('div', {})

  constructor(private readonly ctx: Contesto) {
    const ricontrolla = el('button', { class: 'pulsante', type: 'button', testo: 'Ricontrolla' })
    ricontrolla.addEventListener('click', () => this.ctx.manda({ tipo: 'ambiente.controlla' }))

    const avvia = el('button', { class: 'pulsante principale', type: 'button', testo: 'Avvia il server audio' })
    avvia.addEventListener('click', () => this.ctx.manda({ tipo: 'server.avvia' }))

    const vaiDispositivi = el('button', { class: 'pulsante', type: 'button', testo: 'Vai a Dispositivi' })
    vaiDispositivi.addEventListener('click', () => this.ctx.vai('dispositivi'))
    const cerca = el('button', { class: 'pulsante', type: 'button', testo: 'Cerca Telecamere' })
    cerca.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'telecamera.scansiona', sottorete: null }),
    )
    const vaiZone = el('button', { class: 'pulsante', type: 'button', testo: 'Vai a Zone' })
    vaiZone.addEventListener('click', () => this.ctx.vai('zone'))
    const vaiProduzione = el('button', { class: 'pulsante', type: 'button', testo: 'Vai a Produzione' })
    vaiProduzione.addEventListener('click', () => this.ctx.vai('produzione'))

    this.passoAmbiente.append(
      el(
        'div',
        { class: 'intestazione' },
        el('h3', { testo: '1. Controllo dell\'ambiente' }),
        el('div', { class: 'fila' }, this.quandoControllato, ricontrolla),
      ),
      this.ambiente,
    )

    this.passoServer.append(
      el('h3', { testo: '2. Avvio del server audio' }),
      this.statoServer,
      el('div', { class: 'fila' }, avvia),
    )

    this.passoTelefoni.append(
      el('h3', { testo: '3. I telefoni' }),
      el('p', {
        class: 'nota',
        testo:
          'Su ogni telefono che fara da Altoparlante: installa Snapdroid, scrivi l\'indirizzo del ' +
          'PC qui sotto, togli le restrizioni di batteria all\'app. Su ogni telefono che fara da ' +
          'Telecamera: installa android-ip-camera, disattiva TLS, tienilo in carica.',
      }),
      this.indirizzi,
      el('p', {
        class: 'nota',
        testo:
          'Il rilevamento automatico via mDNS non e disponibile: avahi non e compilato su Windows, ' +
          'e da WSL il multicast verso la LAN non e affidabile. L\'indirizzo va scritto a mano. ' +
          'Il QR con l\'indirizzo e previsto per la Fase 2.',
      }),
    )

    this.passoDispositivi.append(
      el('h3', { testo: '4. Rilevamento dei dispositivi' }),
      this.conteggiDispositivi,
      el('p', {
        class: 'nota',
        testo:
          'Gli Altoparlanti compaiono da soli man mano che i telefoni si collegano. Le Telecamere ' +
          'no: vanno cercate sulla rete o aggiunte per indirizzo.',
      }),
      el('div', { class: 'fila' }, cerca, vaiDispositivi),
    )

    this.passoZone.append(
      el('h3', { testo: '5. Zone e assegnazione' }),
      this.conteggiZone,
      el('p', {
        class: 'nota',
        testo:
          'Crea una Zona per stanza, poi assegna i dispositivi usando Identifica: premi, senti ' +
          'il suono o vedi la torcia, e scegli la Zona nella stessa riga.',
      }),
      el('div', { class: 'fila' }, vaiZone, vaiDispositivi),
    )

    this.passoProva.append(
      el('h3', { testo: '6. Prova' }),
      el('p', {
        class: 'nota',
        testo: 'Un suono di prova per Zona: se lo senti nella stanza giusta, quella Zona e a posto.',
      }),
      this.proveZone,
    )

    this.passoRiepilogo.append(
      el('h3', { testo: '7. Riepilogo' }),
      this.riepilogo,
      el('div', { class: 'fila' }, vaiProduzione),
    )

    this.elemento.append(
      el('h1', { testo: 'Setup guidato' }),
      el('p', {
        class: 'sottotitolo',
        testo:
          'Da fare nel pomeriggio, con calma. Qui un riavvio del server o due secondi di silenzio ' +
          'non costano niente — durante l\'Evento costerebbero tutto.',
      }),
      this.passoAmbiente,
      this.passoServer,
      this.passoTelefoni,
      this.passoDispositivi,
      this.passoZone,
      this.passoProva,
      this.passoRiepilogo,
    )

    this.elencoProve = new Elenco(
      this.proveZone,
      (z) => z.id,
      (z) => this.provaZona(z),
    )
  }

  aggiorna(stato: Stato): void {
    const a = stato.ambiente
    testo(
      this.quandoControllato,
      a.controllatoIl ? `controllato alle ${ora(a.controllatoIl)}` : 'mai controllato',
    )

    const righe: { livello: 'info' | 'attenzione' | 'grave'; testo: string }[] = []
    if (a.wsl === 'assente') {
      righe.push({
        livello: 'grave',
        testo:
          'WSL non e installato. Serve per il server audio, e la sua installazione richiede ' +
          'Virtual Machine Platform e un riavvio di Windows: apri PowerShell come amministratore ' +
          'e lancia "wsl --install", poi riavvia.',
      })
    } else if (a.wsl === 'senza distro') {
      righe.push({
        livello: 'grave',
        testo: `WSL c'e, ma la distro "${a.distro}" no. Cambiala nelle Impostazioni o installala.`,
      })
    } else if (a.wsl === 'ok') {
      righe.push({ livello: 'info', testo: `Distro WSL "${a.distro}": presente.` })
    }

    righe.push(
      a.snapserver
        ? { livello: 'info', testo: `Snapserver ${a.snapserver} trovato nella distro.` }
        : {
            livello: 'grave',
            testo: 'Snapserver non e nella distro: senza, nessun telefono puo suonare.',
          },
    )
    righe.push(
      a.ffmpeg
        ? { livello: a.ffmpeg.includes('PATH') ? 'attenzione' : 'info', testo: `ffmpeg: ${a.ffmpeg}` }
        : { livello: 'attenzione', testo: 'ffmpeg non trovato: la registrazione non funzionera.' },
    )
    if (a.porteOccupate.length > 0) {
      righe.push({
        livello: 'attenzione',
        testo: `Porte gia occupate: ${a.porteOccupate.join(', ')}. Se e il server audio di una ` +
          'sessione precedente va bene; altrimenti qualcosa le sta usando.',
      })
    }
    const soloSenzaFili =
      a.indirizzi.length > 0 && a.indirizzi.every((i) => i.senzaFili)
    if (soloSenzaFili) {
      righe.push({
        livello: 'attenzione',
        testo:
          'Il PC e collegato solo via Wi-Fi. Otto Altoparlanti in PCM stereo sono 11,3 Mbit/s ' +
          'continui, piu il video: collega il PC via cavo e tieni i telefoni sul 5 GHz.',
      })
    }
    this.mostra(this.ambiente, righe)
    classe(this.passoAmbiente, 'fatto', a.wsl === 'ok' && a.snapserver !== null)
    classe(this.passoAmbiente, 'rotto', a.wsl !== 'ok' || a.snapserver === null)

    this.mostra(this.statoServer, [
      stato.server === 'acceso'
        ? { livello: 'info', testo: 'Il server audio e acceso.' }
        : stato.server === 'caduto'
          ? { livello: 'grave', testo: 'Il server audio e caduto: riavvialo.' }
          : { livello: 'attenzione', testo: `Il server audio e ${stato.server}.` },
    ])
    classe(this.passoServer, 'fatto', stato.server === 'acceso')
    classe(this.passoServer, 'rotto', stato.server === 'caduto')

    this.mostra(
      this.indirizzi,
      stato.ambiente.indirizzi.length === 0
        ? [{ livello: 'attenzione', testo: 'Nessun indirizzo di rete trovato.' }]
        : stato.ambiente.indirizzi.map((i) => ({
            livello: 'info' as const,
            testo: `${i.ip} — ${i.interfaccia}${i.senzaFili ? ' (Wi-Fi)' : ''}`,
          })),
    )

    const collegati = stato.altoparlanti.filter((x) => x.collegato).length
    const raggiungibili = stato.telecamere.filter((t) => t.raggiungibile).length
    this.mostra(this.conteggiDispositivi, [
      {
        livello: collegati === 0 ? 'attenzione' : 'info',
        testo: `${collegati} Altoparlanti collegati su ${stato.altoparlanti.length} conosciuti.`,
      },
      {
        livello: raggiungibili === 0 ? 'attenzione' : 'info',
        testo: `${raggiungibili} Telecamere raggiungibili su ${stato.telecamere.length}.`,
      },
    ])
    classe(this.passoDispositivi, 'fatto', collegati > 0 || raggiungibili > 0)

    const assegnati = stato.altoparlanti.filter((x) => x.zonaId).length
    this.mostra(this.conteggiZone, [
      {
        livello: stato.zone.length === 0 ? 'attenzione' : 'info',
        testo: `${stato.zone.length} Zone. ${assegnati} Altoparlanti assegnati, ${
          stato.altoparlanti.length - assegnati
        } non assegnati.`,
      },
    ])
    classe(this.passoZone, 'fatto', stato.zone.length > 0 && assegnati > 0)

    this.elencoProve.sincronizza(
      stato.zone.map((z) => ({
        id: z.id,
        nome: z.nome,
        altoparlantiCollegati: z.altoparlantiCollegati,
      })),
    )

    const avvisi = riepilogoSetup(stato)
    this.mostra(
      this.riepilogo,
      avvisi.length === 0 ? [{ livello: 'info', testo: 'Tutto a posto. Buona serata.' }] : avvisi,
    )
    classe(this.passoRiepilogo, 'fatto', avvisi.every((x) => x.livello === 'info'))
  }

  // -------------------------------------------------------------- interni

  private mostra(
    dove: HTMLElement,
    righe: readonly { livello: 'info' | 'attenzione' | 'grave'; testo: string }[],
  ): void {
    // Questi elenchi cambiano solo quando cambia l'ambiente, cioe quasi mai:
    // ricostruirli e piu semplice che tenerli allineati, e non c'e niente
    // dentro che possa perdere il fuoco.
    const firma = righe.map((r) => `${r.livello}:${r.testo}`).join('|')
    if (dove.dataset['firma'] === firma) return
    dove.dataset['firma'] = firma
    dove.replaceChildren(
      ...righe.map((r) => el('div', { class: `avviso ${r.livello}`, testo: r.testo })),
    )
  }

  private provaZona(iniziale: {
    id: string
    nome: string
    altoparlantiCollegati: number
  }): Voce<{ id: string; nome: string; altoparlantiCollegati: number }> {
    const b = el('button', { class: 'pulsante', type: 'button' })
    b.addEventListener('click', () =>
      this.ctx.manda({ tipo: 'zona.provaAudio', zonaId: iniziale.id }),
    )
    return {
      elemento: b,
      aggiorna: (z) => {
        testo(b, `Prova "${z.nome}"`)
        b.disabled = z.altoparlantiCollegati === 0
        b.title =
          z.altoparlantiCollegati === 0
            ? 'nessun Altoparlante collegato in questa Zona'
            : `${z.altoparlantiCollegati} Altoparlanti collegati`
      },
    }
  }
}
