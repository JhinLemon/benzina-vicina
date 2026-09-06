# Benzina Vicina

Trova i distributori di benzina più convenienti vicino a te, usando i dati ufficiali del MIMIT (Ministero delle Imprese e del Made in Italy), aggiornati ogni giorno.

## Come funziona

Una pipeline Python (`scripts/build_data.py`) scarica ogni mattina i CSV pubblici del MIMIT, li unisce, normalizza carburanti e bandiere, e scrive un file JSON per provincia in `data/`. Il sito statico in `web/` legge il JSON della provincia più vicina (via geolocalizzazione) e mostra la lista ordinabile, con link per aprire il percorso in Mappe.

Nessun server: la pipeline gira una volta al giorno via GitHub Actions, il sito è statico su GitHub Pages.

## Struttura

```
scripts/   script Python che prepara i dati
data/      JSON generati, uno per provincia (es. PD.json)
web/       sito statico (HTML/CSS/JS, nessun framework)
```

## Come si avvia

```bash
uv sync                        # installa le dipendenze in .venv
uv run scripts/build_data.py   # genera i JSON in data/
```

Per provare il sito in locale: `python3 -m http.server --directory web`

## Note

Piano tecnico completo e trappole note: vedi la roadmap discussa con Claude Code (7 step, verificabili uno alla volta).

Fonte dati: MIMIT — *Carburanti, prezzi praticati e anagrafica degli impianti*, licenza IODL 2.0.
