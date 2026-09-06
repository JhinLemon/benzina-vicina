/* Service worker: il pezzo che fa funzionare l'app anche senza rete.

   Un service worker è uno script che il browser tiene acceso *fuori* dalla pagina
   e che intercetta tutte le richieste di rete: può rispondere lui, con quello che
   ha in cache, invece di far uscire la richiesta.

   Due strategie diverse, perché i due tipi di file hanno bisogni opposti:
   - il guscio dell'app (html, css, js): dalla cache subito, è sempre uguale;
   - i dati dei prezzi: prima la rete, perché un prezzo vecchio è inutile, ma
     con la cache pronta a salvare la situazione se la rete non c'è. */

// Cambiare questo numero a ogni modifica del guscio: e' cosi' che il service
// worker capisce di dover buttare la cache vecchia invece di servirla per sempre.
const VERSIONE = "benzina-vicina-v2";
const CACHE_GUSCIO = `${VERSIONE}-guscio`;
const CACHE_DATI = `${VERSIONE}-dati`;

const FILE_GUSCIO = [
  ".",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "icon-180.png",
  "vendor/leaflet.js",
  "vendor/leaflet.css",
];

// I tasselli della mappa arrivano da openstreetmap.org, quindi da un altro dominio:
// il service worker li lascia passare e non li salva. Senza rete la mappa mostra i
// marcatori su fondo vuoto, mentre la lista continua a funzionare del tutto.

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_GUSCIO).then((cache) => cache.addAll(FILE_GUSCIO))
  );
  // Non aspetta che l'utente chiuda tutte le schede per attivare la versione nuova
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys().then((nomi) =>
      Promise.all(
        nomi
          .filter((nome) => !nome.startsWith(VERSIONE))
          .map((nome) => caches.delete(nome))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (evento) => {
  const richiesta = evento.request;

  // Il service worker vede tutte le richieste, anche quelle verso Google Fonts
  // o Apple Maps: qui gestisco solo quelle del mio sito, il resto passa liscio.
  if (richiesta.method !== "GET") return;
  if (new URL(richiesta.url).origin !== self.location.origin) return;

  if (richiesta.url.includes("/data/")) {
    evento.respondWith(primaLaRete(richiesta));
  } else {
    evento.respondWith(primaLaCache(richiesta));
  }
});

/** Prezzi: prova la rete, e se non c'è tira fuori l'ultima copia salvata. */
async function primaLaRete(richiesta) {
  const cache = await caches.open(CACHE_DATI);

  try {
    const risposta = await fetch(richiesta);
    if (risposta.ok) cache.put(richiesta, risposta.clone());
    return risposta;
  } catch (errore) {
    const salvata = await cache.match(richiesta);
    if (salvata) return salvata;
    throw errore;
  }
}

/** Guscio: rispondi dalla cache, e intanto aggiorna in silenzio per la volta dopo. */
async function primaLaCache(richiesta) {
  const cache = await caches.open(CACHE_GUSCIO);
  const salvata = await cache.match(richiesta);

  const aggiornamento = fetch(richiesta)
    .then((risposta) => {
      if (risposta.ok) cache.put(richiesta, risposta.clone());
      return risposta;
    })
    .catch(() => null);

  return salvata || aggiornamento.then((r) => r || Response.error());
}
