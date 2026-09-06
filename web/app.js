/* Benzina Vicina — logica dell'interfaccia.

   Niente framework: il lavoro è leggere un JSON, ordinare una lista e disegnarla.
   Tutto lo stato dell'app sta in un unico oggetto `stato`, così per capire cosa
   sta succedendo basta guardare lì dentro. */

"use strict";

const RAGGIO_TERRA_KM = 6371;
const PROVINCE_DA_CARICARE = 3; // le province italiane sono piccole: il distributore
                                // più vicino può stare benissimo appena oltre il confine
const GIORNI_PREZZO_VECCHIO = 3;
const MASSIMO_IN_LISTA = 30;

const stato = {
  posizione: null,
  indiceProvince: [],
  impianti: [],
  estrazione: null,
  provinceCaricate: [],
  espanso: null,
  filtri: {
    carburante: "benzina",
    // `modalita` è quella in uso adesso; `modalitaScelta` è l'ultima che ha scelto
    // l'utente. Sono due cose diverse: col metano l'app deve forzare il servito,
    // ma tornando sulla benzina deve rimettere quello che voleva lui.
    modalita: "self",
    modalitaScelta: "self",
    raggio: 10,
    bandiera: "tutte",
    ordine: "prezzo",
    escludiAutostrada: true,
  },
  preferenze: { litri: 40, consumo: 15 },
};

/* ---------- utilità ---------- */

/** Distanza in linea d'aria fra due punti, formula dell'emisenoverso (haversine).
 *
 * La Terra è una sfera, quindi non si può usare Pitagora sulle coordinate:
 * un grado di longitudine vale ~111 km all'equatore ma si accorcia salendo
 * verso il polo. Questa formula tiene conto della curvatura. */
function distanzaKm(lat1, lon1, lat2, lon2) {
  const gradiInRadianti = Math.PI / 180;
  const dLat = (lat2 - lat1) * gradiInRadianti;
  const dLon = (lon2 - lon1) * gradiInRadianti;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * gradiInRadianti) *
      Math.cos(lat2 * gradiInRadianti) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  return RAGGIO_TERRA_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Formatta un prezzo alla maniera dei cartelloni dei distributori:
 *  virgola decimale italiana e terzo decimale più piccolo. */
function prezzoHtml(valore) {
  const testo = valore.toFixed(3).replace(".", ",");
  const principale = testo.slice(0, -1);
  const millesimi = testo.slice(-1);
  return `<span class="prezzo">${principale}<span class="millesimi">${millesimi}</span></span>`;
}

function euro(valore) {
  return valore.toFixed(2).replace(".", ",") + " €";
}

function km(valore) {
  const cifre = valore < 10 ? 1 : 0;
  return valore.toFixed(cifre).replace(".", ",") + " km";
}

function testoSicuro(testo) {
  const elemento = document.createElement("div");
  elemento.textContent = testo;
  return elemento.innerHTML;
}

/** Da quanti giorni un prezzo è fermo, contati rispetto al giorno dell'estrazione.
 *
 * Il paragone non è con oggi ma con la data del file del ministero: quel file può
 * già essere di qualche giorno fa, e contando da oggi risulterebbero vecchi tutti
 * i prezzi, anche quelli comunicati la mattina stessa. Confrontando con
 * l'estrazione l'etichetta dice davvero "questo benzinaio non aggiorna". */
function giorniDaEstrazione(dataIso) {
  if (!dataIso || !stato.estrazione) return null;

  const prezzo = new Date(dataIso + "T12:00:00").getTime();
  const estrazione = new Date(stato.estrazione + "T12:00:00").getTime();
  return Math.max(0, Math.round((estrazione - prezzo) / (1000 * 60 * 60 * 24)));
}

/* ---------- caricamento dati ---------- */

async function leggiJson(percorso) {
  const risposta = await fetch(percorso, { cache: "no-cache" });
  if (!risposta.ok) throw new Error(`${percorso}: HTTP ${risposta.status}`);
  return risposta.json();
}

async function caricaIndice() {
  const indice = await leggiJson("data/index.json");
  stato.indiceProvince = indice.province;
  stato.estrazione = indice.estrazione;
  riempiElencoProvince();
}

/** Sceglie le province da scaricare: le più vicine al punto in cui sei.
 *
 * Il centro di ogni provincia è la media delle coordinate dei suoi distributori
 * (lo calcola build_data.py). Non è preciso al metro, ma per dire "queste tre
 * province sono quelle intorno a me" è più che sufficiente. */
function provinceVicine(lat, lon, quante) {
  const conDistanza = stato.indiceProvince.map((p) => ({
    provincia: p.provincia,
    distanza: distanzaKm(lat, lon, p.lat, p.lon),
  }));

  conDistanza.sort((a, b) => a.distanza - b.distanza);
  return conDistanza.slice(0, quante).map((p) => p.provincia);
}

async function caricaProvince(sigle) {
  const documenti = await Promise.all(sigle.map((s) => leggiJson(`data/${s}.json`)));

  stato.impianti = documenti.flatMap((d) => d.impianti);
  stato.provinceCaricate = sigle;
  stato.estrazione = documenti[0].estrazione;

  // Tengo una copia in locale: al prossimo avvio senza rete l'app mostra
  // comunque questi dati invece di una pagina bianca.
  try {
    localStorage.setItem(
      "ultimi-dati",
      JSON.stringify({
        estrazione: stato.estrazione,
        province: sigle,
        impianti: stato.impianti,
      })
    );
  } catch (errore) {
    // localStorage pieno o disattivato: non è un problema, si perde solo la cache
  }

  riempiElencoBandiere();
}

function recuperaDatiSalvati() {
  try {
    const salvato = localStorage.getItem("ultimi-dati");
    if (!salvato) return false;

    const dati = JSON.parse(salvato);
    stato.impianti = dati.impianti;
    stato.estrazione = dati.estrazione;
    stato.provinceCaricate = dati.province;
    riempiElencoBandiere();
    return true;
  } catch (errore) {
    return false;
  }
}

/* ---------- preferenze salvate ---------- */

function salvaPreferenze() {
  try {
    localStorage.setItem(
      "preferenze",
      JSON.stringify({ filtri: stato.filtri, preferenze: stato.preferenze })
    );
  } catch (errore) {
    // niente da fare: l'app funziona uguale, si riparte dai valori di default
  }
}

function caricaPreferenze() {
  try {
    const salvato = localStorage.getItem("preferenze");
    if (!salvato) return;

    const dati = JSON.parse(salvato);
    Object.assign(stato.filtri, dati.filtri || {});
    Object.assign(stato.preferenze, dati.preferenze || {});
  } catch (errore) {
    // preferenze illeggibili: si ignorano
  }
}

/* ---------- selezione e calcolo ---------- */

function prezzoDi(impianto) {
  const perCarburante = impianto.prezzi[stato.filtri.carburante];
  if (!perCarburante) return null;

  const valore = perCarburante[stato.filtri.modalita];
  return typeof valore === "number" ? valore : null;
}

/** Spegne le modalità che per il carburante scelto non esistono.
 *
 * GPL e metano in Italia si fanno quasi sempre col servito: cercarli in self
 * darebbe una lista vuota, e l'utente penserebbe che l'app è rotta invece che
 * "questa cosa non esiste". Meglio dirglielo spegnendo il bottone.
 *
 * Il conteggio è su tutti gli impianti caricati, non su quelli dentro il raggio:
 * altrimenti i bottoni si accenderebbero e spegnerebbero muovendo il cursore. */
function contaModalita(carburante) {
  const disponibili = { self: 0, servito: 0 };

  for (const impianto of stato.impianti) {
    const prezzi = impianto.prezzi[carburante];
    if (!prezzi) continue;
    if (typeof prezzi.self === "number") disponibili.self++;
    if (typeof prezzi.servito === "number") disponibili.servito++;
  }

  return disponibili;
}

function aggiornaDisponibilitaModalita() {
  const disponibili = contaModalita(stato.filtri.carburante);

  // Spengo solo il caso impossibile: il metano in self non esiste proprio.
  document.querySelectorAll("[data-modalita]").forEach((bottone) => {
    bottone.disabled = disponibili[bottone.dataset.modalita] === 0;
  });

  if (disponibili[stato.filtri.modalita] === 0) {
    impostaModalita(stato.filtri.modalita === "self" ? "servito" : "self");
  }
}

/** La modalità "normale" per un carburante, o null se sono entrambe comuni.
 *
 * Il GPL ha 6 impianti self contro 258 serviti: tecnicamente il self esiste, ma
 * chi cerca GPL vuole vedere il servito. Sotto un decimo dell'altra la considero
 * un'eccezione e non la scelgo di default — restando comunque cliccabile, perché
 * chi abita vicino a uno di quei 6 ha diritto di trovarlo. */
function modalitaPredominante(carburante) {
  const disponibili = contaModalita(carburante);

  if (disponibili.self > disponibili.servito * 10) return "self";
  if (disponibili.servito > disponibili.self * 10) return "servito";
  return null;
}

function impostaModalita(modalita) {
  stato.filtri.modalita = modalita;
  document.querySelectorAll("[data-modalita]").forEach((b) => {
    b.classList.toggle("attiva", b.dataset.modalita === modalita);
  });
}

/** Applica i filtri e restituisce la lista con distanza e prezzo già calcolati. */
function impiantiFiltrati() {
  const { lat, lon } = stato.posizione;
  const risultato = [];

  for (const impianto of stato.impianti) {
    const prezzo = prezzoDi(impianto);
    if (prezzo === null) continue;

    if (stato.filtri.escludiAutostrada && impianto.tipo === "Autostradale") continue;
    if (stato.filtri.bandiera !== "tutte" && impianto.gruppo !== stato.filtri.bandiera) continue;

    const distanza = distanzaKm(lat, lon, impianto.lat, impianto.lon);
    if (distanza > stato.filtri.raggio) continue;

    risultato.push({ impianto, prezzo, distanza });
  }

  return risultato;
}

/** Quanto risparmi davvero andando in un distributore invece che nel più vicino.
 *
 * È la formula della sezione 06 del piano: al risparmio sul pieno va tolto il
 * carburante che bruci per fare i chilometri in più, andata e ritorno.
 * Il termine di paragone è il distributore più vicino, cioè quello dove
 * andresti senza pensarci. */
function calcolaConvenienza(elenco) {
  if (elenco.length === 0) return;

  const riferimento = elenco.reduce((a, b) => (a.distanza <= b.distanza ? a : b));
  const { litri, consumo } = stato.preferenze;

  for (const voce of elenco) {
    const risparmio = (riferimento.prezzo - voce.prezzo) * litri;

    // Solo i km in PIÙ rispetto al riferimento sono un costo aggiuntivo,
    // e vanno contati due volte perché poi devi tornare indietro.
    const kmExtra = Math.max(0, voce.distanza - riferimento.distanza) * 2;
    const costoExtra = (kmExtra / consumo) * voce.prezzo;

    voce.guadagno = risparmio - costoExtra;
    voce.riferimento = voce === riferimento;
  }
}

function ordina(elenco) {
  const copia = elenco.slice();

  if (stato.filtri.ordine === "distanza") {
    copia.sort((a, b) => a.distanza - b.distanza);
  } else if (stato.filtri.ordine === "convenienza") {
    copia.sort((a, b) => b.guadagno - a.guadagno);
  } else {
    copia.sort((a, b) => a.prezzo - b.prezzo);
  }

  return copia;
}

/* ---------- disegno ---------- */

const risultati = document.getElementById("risultati");
const messaggioStato = document.getElementById("stato");

function mostraMessaggio(html) {
  risultati.innerHTML = `<p class="vuoto">${html}</p>`;
}

function nomeVisibile(impianto) {
  // Molti "nomi impianto" sono codici interni tipo "19834 MONTALLEGRO":
  // in quel caso la bandiera dice molto di più all'utente.
  const nome = impianto.nome.trim();
  const soloCodice = /^\d[\d\s.-]*$/.test(nome);
  if (!nome || soloCodice) return impianto.bandiera;
  return nome;
}

function etichettaVecchio(impianto) {
  const giorni = giorniDaEstrazione(impianto.aggiornato);
  if (giorni === null || giorni <= GIORNI_PREZZO_VECCHIO) return "";
  return `<span class="vecchio">fermo da ${giorni} giorni</span>`;
}

function bloccoMigliore(voce) {
  const impianto = voce.impianto;
  const guadagno = voce.guadagno;

  let spiegazione;
  if (voce.riferimento) {
    spiegazione = "È anche il più vicino: non c'è di meglio in giro.";
  } else if (guadagno >= 0.5) {
    spiegazione = `Rispetto al più vicino risparmi <b>${euro(guadagno)}</b>, già tolto il carburante per arrivarci.`;
  } else {
    spiegazione = `Rispetto al più vicino guadagni solo <b>${euro(Math.max(0, guadagno))}</b>: quasi pari, valuta se vale il viaggio.`;
  }

  return `
    <section class="migliore entra">
      <p class="migliore-etichetta">Conviene di più</p>
      <div class="migliore-corpo">
        <div class="migliore-info">
          <p class="migliore-nome">${testoSicuro(nomeVisibile(impianto))}</p>
          <p class="migliore-dove">${testoSicuro(impianto.comune)} · ${km(voce.distanza)} · ${testoSicuro(impianto.bandiera)}</p>
        </div>
        ${prezzoHtml(voce.prezzo)}
      </div>
      <p class="risparmio">${spiegazione}</p>
      <div class="azioni">
        <a class="azione" href="${percorsoAppleMaps(impianto)}">Portami lì</a>
        <a class="azione secondaria" href="${percorsoGoogleMaps(impianto)}">Google Maps</a>
      </div>
    </section>`;
}

function rigaLista(voce, indice) {
  const impianto = voce.impianto;
  const aperto = stato.espanso === impianto.id;

  let dettaglio = "";
  if (aperto) {
    dettaglio = `
      <div class="dettaglio">
        <p class="dettaglio-indirizzo">${testoSicuro(impianto.indirizzo)}, ${testoSicuro(impianto.comune)}</p>
        ${tabellaPrezzi(impianto)}
        <div class="azioni">
          <a class="azione" href="${percorsoAppleMaps(impianto)}">Portami lì</a>
          <a class="azione secondaria" href="${percorsoGoogleMaps(impianto)}">Google Maps</a>
        </div>
      </div>`;
  }

  return `
    <li class="riga">
      <button type="button" class="riga-testa" data-id="${impianto.id}" aria-expanded="${aperto}">
        ${prezzoHtml(voce.prezzo)}
        <span class="riga-info">
          <span class="riga-nome">${testoSicuro(nomeVisibile(impianto))}</span><br>
          <span class="riga-dove">${testoSicuro(impianto.comune)} · ${testoSicuro(impianto.bandiera)}${etichettaVecchio(impianto)}</span>
        </span>
        <span class="riga-distanza">${km(voce.distanza)}</span>
      </button>
      ${dettaglio}
    </li>`;
}

function tabellaPrezzi(impianto) {
  const nomi = { benzina: "Benzina", gasolio: "Gasolio", gpl: "GPL", metano: "Metano" };
  let righe = "";

  for (const chiave of Object.keys(nomi)) {
    const prezzi = impianto.prezzi[chiave];
    if (!prezzi) continue;

    const self = typeof prezzi.self === "number" ? prezzi.self.toFixed(3).replace(".", ",") : "—";
    const servito = typeof prezzi.servito === "number" ? prezzi.servito.toFixed(3).replace(".", ",") : "—";

    righe += `<tr>
      <th>${nomi[chiave]}</th>
      <td class="${self === "—" ? "assente" : ""}">${self}</td>
      <td class="${servito === "—" ? "assente" : ""}">${servito}</td>
    </tr>`;
  }

  const giorni = giorniDaEstrazione(impianto.aggiornato);
  const quando =
    giorni === 0
      ? "il giorno della rilevazione"
      : giorni === 1
        ? "il giorno prima della rilevazione"
        : `${giorni} giorni prima della rilevazione`;

  return `
    <table class="tabella-prezzi">
      <thead><tr><th></th><th style="text-align:right">Self</th><th style="text-align:right">Servito</th></tr></thead>
      <tbody>${righe}</tbody>
    </table>
    <p class="nota">Prezzi comunicati ${quando}.</p>`;
}

/** Le coordinate finiscono dentro un href: le forzo a numero prima di scriverle.
 *
 * Number() su un valore inatteso dà NaN, mai testo: così è impossibile che un
 * campo del file del ministero inietti attributi o codice dentro il link. */
function coordinate(impianto) {
  return `${Number(impianto.lat)},${Number(impianto.lon)}`;
}

function percorsoAppleMaps(impianto) {
  return `https://maps.apple.com/?daddr=${coordinate(impianto)}&dirflg=d`;
}

function percorsoGoogleMaps(impianto) {
  return `https://www.google.com/maps/dir/?api=1&destination=${coordinate(impianto)}&travelmode=driving`;
}

function disegna() {
  if (!stato.posizione || stato.impianti.length === 0) return;

  aggiornaDisponibilitaModalita();

  const elenco = impiantiFiltrati();

  if (elenco.length === 0) {
    mostraVuoto();
    aggiornaStato(0);
    return;
  }

  calcolaConvenienza(elenco);

  // Il blocco in cima è sempre il più conveniente davvero, qualunque sia
  // l'ordinamento scelto per la lista sotto: sono due domande diverse.
  const migliore = elenco.reduce((a, b) => (a.guadagno >= b.guadagno ? a : b));
  const ordinati = ordina(elenco).slice(0, MASSIMO_IN_LISTA);

  risultati.innerHTML =
    bloccoMigliore(migliore) +
    `<ul class="elenco">${ordinati.map(rigaLista).join("")}</ul>`;

  aggiornaStato(elenco.length);
}

/** Schermata vuota: non basta dire che non c'è niente, va detto cosa fare.
 *
 * Provo io le due vie d'uscita (l'altra modalità, un raggio più largo) e propongo
 * quella che funziona davvero, con già scritto quanti risultati troverebbe. */
function mostraVuoto() {
  const carburante = stato.filtri.carburante;
  const altra = stato.filtri.modalita === "self" ? "servito" : "self";

  const modalitaPrecedente = stato.filtri.modalita;
  stato.filtri.modalita = altra;
  const quantiConAltra = impiantiFiltrati().length;
  stato.filtri.modalita = modalitaPrecedente;

  const raggioPrecedente = stato.filtri.raggio;
  stato.filtri.raggio = 50;
  const quantiPiuLontano = impiantiFiltrati().length;
  stato.filtri.raggio = raggioPrecedente;

  let uscita = "";
  if (quantiConAltra > 0) {
    uscita = `<button type="button" class="azione" id="vai-altra-modalita">Guarda il ${altra} (${quantiConAltra})</button>`;
  } else if (quantiPiuLontano > 0) {
    uscita = `<button type="button" class="azione" id="allarga-raggio">Cerca entro 50 km (${quantiPiuLontano})</button>`;
  }

  mostraMessaggio(
    `Nessun distributore con ${carburante} ${modalitaPrecedente} entro ${raggioPrecedente} km.<br>${uscita}`
  );

  const bottoneModalita = document.getElementById("vai-altra-modalita");
  if (bottoneModalita) {
    bottoneModalita.addEventListener("click", () => {
      impostaModalita(altra);
      salvaPreferenze();
      disegna();
    });
  }

  const bottoneRaggio = document.getElementById("allarga-raggio");
  if (bottoneRaggio) {
    bottoneRaggio.addEventListener("click", () => {
      stato.filtri.raggio = 50;
      document.getElementById("raggio").value = 50;
      document.getElementById("raggio-valore").textContent = "50 km";
      salvaPreferenze();
      disegna();
    });
  }
}

function aggiornaStato(quanti) {
  const province = stato.provinceCaricate.join(", ");
  messaggioStato.textContent =
    quanti === 1
      ? `1 distributore entro ${stato.filtri.raggio} km · ${province}`
      : `${quanti} distributori entro ${stato.filtri.raggio} km · ${province}`;

  const riga = document.getElementById("riga-dati");
  if (stato.estrazione) {
    riga.textContent = `Prezzi ufficiali MIMIT del ${stato.estrazione.split("-").reverse().join("/")}, licenza IODL 2.0.`;
  }
}

/* ---------- elenchi a tendina ---------- */

function riempiElencoBandiere() {
  const select = document.getElementById("bandiera");
  const presenti = [...new Set(stato.impianti.map((i) => i.gruppo))].sort();

  select.innerHTML =
    `<option value="tutte">Tutte</option>` +
    presenti.map((b) => `<option value="${testoSicuro(b)}">${testoSicuro(b)}</option>`).join("");

  select.value = presenti.includes(stato.filtri.bandiera) ? stato.filtri.bandiera : "tutte";
  stato.filtri.bandiera = select.value;
}

function riempiElencoProvince() {
  const select = document.getElementById("provincia-manuale");
  const sigle = stato.indiceProvince.map((p) => p.provincia).sort();

  select.innerHTML =
    `<option value="auto">Automatica, dalla posizione</option>` +
    sigle.map((s) => `<option value="${s}">${s}</option>`).join("");
}

/* ---------- posizione ---------- */

function centroProvincia(sigla) {
  const trovata = stato.indiceProvince.find((p) => p.provincia === sigla);
  return trovata ? { lat: trovata.lat, lon: trovata.lon } : null;
}

async function usaProvinciaManuale(sigla) {
  const centro = centroProvincia(sigla);
  if (!centro) return;

  messaggioStato.textContent = `Carico ${sigla}…`;
  stato.posizione = centro;

  // Senza GPS non ho un punto vero: il raggio dal centro provincia sarebbe
  // troppo stretto, quindi lo allargo abbastanza da coprire tutta la provincia.
  if (stato.filtri.raggio < 30) {
    stato.filtri.raggio = 30;
    document.getElementById("raggio").value = 30;
    document.getElementById("raggio-valore").textContent = "30 km";
  }

  await caricaProvince([sigla]);
  disegna();
}

function chiediPosizione() {
  if (!navigator.geolocation) {
    mostraSenzaPosizione("Questo browser non sa dire dove sei.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (posizione) => {
      stato.posizione = {
        lat: posizione.coords.latitude,
        lon: posizione.coords.longitude,
      };

      try {
        const sigle = provinceVicine(stato.posizione.lat, stato.posizione.lon, PROVINCE_DA_CARICARE);
        messaggioStato.textContent = `Carico ${sigle.join(", ")}…`;
        await caricaProvince(sigle);
        disegna();
      } catch (errore) {
        if (recuperaDatiSalvati()) {
          disegna();
          messaggioStato.textContent = "Sei senza rete: dati dell'ultima volta.";
        } else {
          mostraMessaggio("Non riesco a scaricare i dati. Controlla la connessione.");
        }
      }
    },
    (errore) => {
      const spiegazione =
        errore.code === errore.PERMISSION_DENIED
          ? "Non mi hai dato il permesso di sapere dove sei."
          : "Non riesco a leggere la posizione.";
      mostraSenzaPosizione(spiegazione);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 }
  );
}

function mostraSenzaPosizione(spiegazione) {
  messaggioStato.textContent = "Posizione non disponibile";
  mostraMessaggio(
    `${spiegazione}<br>Scegli la provincia dalle impostazioni, oppure riprova.
     <br><button type="button" class="azione" id="riprova-posizione">Riprova</button>`
  );

  document.getElementById("riprova-posizione").addEventListener("click", () => {
    messaggioStato.textContent = "Cerco dove sei…";
    mostraMessaggio("Cerco dove sei…");
    chiediPosizione();
  });
}

/* ---------- eventi ---------- */

function collegaEventi() {
  document.querySelectorAll("[data-carburante]").forEach((bottone) => {
    bottone.addEventListener("click", () => {
      stato.filtri.carburante = bottone.dataset.carburante;
      document.querySelectorAll("[data-carburante]").forEach((b) => b.classList.remove("attiva"));
      bottone.classList.add("attiva");

      // Il vincolo del carburante vince, altrimenti torna quello che voleva l'utente
      impostaModalita(modalitaPredominante(stato.filtri.carburante) || stato.filtri.modalitaScelta);

      stato.espanso = null;
      salvaPreferenze();
      disegna();
    });
  });

  document.querySelectorAll("[data-modalita]").forEach((bottone) => {
    bottone.addEventListener("click", () => {
      impostaModalita(bottone.dataset.modalita);
      stato.filtri.modalitaScelta = bottone.dataset.modalita;
      stato.espanso = null;
      salvaPreferenze();
      disegna();
    });
  });

  const apri = document.getElementById("apri-impostazioni");
  const pannello = document.getElementById("pannello-impostazioni");
  apri.addEventListener("click", () => {
    const eraAperto = !pannello.hidden;
    pannello.hidden = eraAperto;
    apri.setAttribute("aria-expanded", String(!eraAperto));
    apri.textContent = eraAperto ? "Impostazioni" : "Chiudi";
  });

  const raggio = document.getElementById("raggio");
  const raggioValore = document.getElementById("raggio-valore");
  raggio.addEventListener("input", () => {
    stato.filtri.raggio = Number(raggio.value);
    raggioValore.textContent = `${raggio.value} km`;
    disegna();
  });
  raggio.addEventListener("change", salvaPreferenze);

  document.getElementById("bandiera").addEventListener("change", (evento) => {
    stato.filtri.bandiera = evento.target.value;
    salvaPreferenze();
    disegna();
  });

  document.getElementById("ordine").addEventListener("change", (evento) => {
    stato.filtri.ordine = evento.target.value;
    salvaPreferenze();
    disegna();
  });

  document.getElementById("escludi-autostrada").addEventListener("change", (evento) => {
    stato.filtri.escludiAutostrada = evento.target.checked;
    salvaPreferenze();
    disegna();
  });

  document.getElementById("litri").addEventListener("change", (evento) => {
    stato.preferenze.litri = Number(evento.target.value) || 40;
    salvaPreferenze();
    disegna();
  });

  document.getElementById("consumo").addEventListener("change", (evento) => {
    stato.preferenze.consumo = Number(evento.target.value) || 15;
    salvaPreferenze();
    disegna();
  });

  document.getElementById("provincia-manuale").addEventListener("change", (evento) => {
    if (evento.target.value === "auto") {
      chiediPosizione();
    } else {
      usaProvinciaManuale(evento.target.value);
    }
  });

  // Un solo ascoltatore sul contenitore invece di uno per riga: le righe vengono
  // ridisegnate a ogni filtro, e riagganciare 30 ascoltatori ogni volta è spreco.
  risultati.addEventListener("click", (evento) => {
    const testa = evento.target.closest(".riga-testa");
    if (!testa) return;

    const id = Number(testa.dataset.id);
    stato.espanso = stato.espanso === id ? null : id;
    disegna();
  });
}

function applicaPreferenzeAllInterfaccia() {
  document.querySelectorAll("[data-carburante]").forEach((b) => {
    b.classList.toggle("attiva", b.dataset.carburante === stato.filtri.carburante);
  });
  document.querySelectorAll("[data-modalita]").forEach((b) => {
    b.classList.toggle("attiva", b.dataset.modalita === stato.filtri.modalita);
  });

  document.getElementById("raggio").value = stato.filtri.raggio;
  document.getElementById("raggio-valore").textContent = `${stato.filtri.raggio} km`;
  document.getElementById("ordine").value = stato.filtri.ordine;
  document.getElementById("escludi-autostrada").checked = stato.filtri.escludiAutostrada;
  document.getElementById("litri").value = stato.preferenze.litri;
  document.getElementById("consumo").value = stato.preferenze.consumo;
}

/* ---------- avvio ---------- */

async function avvia() {
  caricaPreferenze();
  applicaPreferenzeAllInterfaccia();
  collegaEventi();

  try {
    await caricaIndice();
  } catch (errore) {
    if (recuperaDatiSalvati() && stato.posizione) {
      disegna();
      return;
    }
    mostraMessaggio("Non riesco a scaricare i dati. Controlla la connessione e ricarica.");
    return;
  }

  chiediPosizione();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // senza service worker l'app funziona lo stesso, solo non offline
    });
  });
}

avvia();
