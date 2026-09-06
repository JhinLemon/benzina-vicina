# Benzina Vicina

Trova i distributori più convenienti vicino a te, con i prezzi ufficiali del MIMIT
(Ministero delle Imprese e del Made in Italy) aggiornati ogni giorno.

Non mostra solo il più economico: calcola **quanto risparmi davvero**, tolto il carburante
che consumi per arrivarci. Spesso il distributore a 8 km che costa 5 centesimi in meno
non conviene affatto.

## Come funziona

Il lavoro è diviso in due metà che non si toccano mai direttamente:

1. **Una volta al giorno, su GitHub Actions** — `scripts/build_data.py` scarica i due CSV
   pubblici del ministero (~7 MB), li unisce, normalizza le 58 varianti commerciali di
   carburante in 4 categorie, scarta i dati rotti e scrive un JSON per provincia.
2. **Ogni volta che apri l'app, sul telefono** — la pagina capisce in che provincia sei,
   scarica solo i 3 JSON delle province più vicine (50–300 KB l'uno), calcola distanze e
   convenienza, e mostra la lista.

Il contratto fra le due metà è la forma del JSON: se cambia quella, cambiano entrambe.

Non c'è nessun server: la pipeline gira su GitHub Actions, il sito è statico su GitHub Pages.
Costo totale: zero.

## Struttura

```
scripts/build_data.py     scarica i CSV del MIMIT e costruisce i JSON
scripts/verifica_dati.py  controlla che i dati abbiano senso prima di pubblicarli
web/                      il sito: HTML, CSS e JavaScript a mano, nessun framework
web/data/                 i JSON generati (non versionati: si ricostruiscono)
.github/workflows/        l'automazione giornaliera
```

## Lavorarci in locale

```bash
uv sync                          # crea .venv con Python 3.13
uv run scripts/build_data.py     # scarica i dati e genera web/data/
uv run scripts/verifica_dati.py  # controlla che siano sensati
python3 -m http.server --directory web 8765
```

Poi apri <http://localhost:8765>. La geolocalizzazione funziona su `localhost` anche senza
HTTPS, perché il browser considera `localhost` un contesto sicuro.

Prima di committare:

```bash
ruff check scripts/ && ruff format scripts/
```

## Scelte da sapere

- **I prezzi "premium" sono esclusi.** V-Power, Blue Diesel, HVO e simili costano di più
  perché sono prodotti diversi: metterli nella stessa classifica della benzina normale
  falserebbe il confronto. Restano fuori.
- **Self e servito non si mescolano mai.** Il servito costa 30–40 centesimi in più.
- **I prezzi più vecchi di 7 giorni vengono buttati**, e quelli fermi da più di 3 giorni
  rispetto alla rilevazione sono segnalati nella lista.
- **Le distanze sono in linea d'aria**, non su strada: servono a ordinare, non a navigare.
- **GPL e metano sono quasi sempre "servito"** (per legge): l'app se ne accorge e
  imposta da sola la modalità giusta quando scegli quei carburanti.

## Manutenzione

L'app è online su <https://jhinlemon.github.io/benzina-vicina/> e si aggiorna da sola
ogni mattina alle 8:00 UTC (le 10:00 italiane d'estate, le 9:00 d'inverno).

Due cose da sapere per non trovarsela rotta senza capire perché:

- **GitHub spegne i workflow programmati dopo 60 giorni senza attività sul repository.**
  Non avvisa. Se un giorno i prezzi smettono di aggiornarsi, è quasi certamente questo:
  basta un commit qualsiasi, o premere "Run workflow" dalla scheda Actions, per
  riattivarlo. Il conteggio riparte da ogni push.
- **Se il workflow fallisce, il sito resta com'era.** È voluto: `verifica_dati.py` blocca
  la pubblicazione se i dati non hanno senso, quindi in caso di guasto vedi prezzi vecchi
  invece di una pagina vuota. Lo stato delle esecuzioni è nella scheda Actions del repo.

## Fonte dei dati

Ministero delle Imprese e del Made in Italy — *Carburanti, prezzi praticati e anagrafica
degli impianti*, licenza IODL 2.0. La licenza obbliga a citare la fonte in ogni riuso
pubblico: la citazione è in fondo alla pagina dell'app.
