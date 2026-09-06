"""Controlla che i dati appena costruiti abbiano senso, prima di pubblicarli.

Serve a un caso preciso: il ministero cambia il formato del file (e' gia' successo,
dalla virgola alla barra verticale) e build_data.py, invece di esplodere, produce
un JSON perfettamente valido ma vuoto. Senza questo controllo quel file finirebbe
online e sostituirebbe dati buoni con niente.

Se uno di questi controlli fallisce lo script esce con codice 1, GitHub Actions
ferma il workflow e sul sito resta l'ultima versione funzionante.

Uso:  uv run scripts/verifica_dati.py
"""

import json
import sys
from datetime import date, datetime
from pathlib import Path

# I limiti li importo invece di riscriverli: se un giorno cambio quelli in
# build_data.py e qui restassero i vecchi, il controllo boccerebbe dati corretti
# (o peggio, ne farebbe passare di sbagliati). Un valore, un posto solo.
from build_data import FUSO_ITALIA, LIMITI_PREZZO

CARTELLA_DATI = Path(__file__).parent.parent / "web" / "data"

# L'Italia ha 107 province. Sotto le 90 e' successo qualcosa di grosso.
MINIMO_PROVINCE = 90
MINIMO_IMPIANTI = 15000

# Se il file del ministero e' fermo da piu' di 10 giorni, i prezzi non sono
# piu' attendibili: meglio non pubblicare che pubblicare roba vecchia.
MASSIMO_GIORNI_ESTRAZIONE = 10

CARBURANTI_ATTESI = set(LIMITI_PREZZO)


def errore(messaggio):
    print(f"  FALLITO: {messaggio}")
    return 1


def verifica_indice():
    """Controlla index.json: numero di province, totale impianti, data."""
    problemi = 0
    percorso = CARTELLA_DATI / "index.json"

    if not percorso.exists():
        return errore("manca index.json")

    indice = json.loads(percorso.read_text(encoding="utf-8"))
    province = indice["province"]

    print(f"  province: {len(province)}")
    if len(province) < MINIMO_PROVINCE:
        problemi += errore(f"solo {len(province)} province, ne servono almeno {MINIMO_PROVINCE}")

    totale = sum(p["impianti"] for p in province)
    print(f"  impianti totali: {totale}")
    if totale < MINIMO_IMPIANTI:
        problemi += errore(f"solo {totale} impianti, ne servono almeno {MINIMO_IMPIANTI}")

    # "oggi" e' oggi in Italia, non sul server di GitHub che vive in UTC
    oggi = datetime.now(tz=FUSO_ITALIA).date()
    # date.fromisoformat legge direttamente una data: non c'e' nessun orario da
    # inventare, quindi nessun fuso da dichiarare.
    estrazione = date.fromisoformat(indice["estrazione"])
    giorni = (oggi - estrazione).days
    print(f"  estrazione del {estrazione} ({giorni} giorni fa)")
    if giorni > MASSIMO_GIORNI_ESTRAZIONE:
        problemi += errore(f"il dato del ministero e' fermo da {giorni} giorni")

    return problemi


def verifica_impianti():
    """Scorre tutti i file provincia e controlla il contenuto degli impianti."""
    problemi = 0
    file_province = sorted(p for p in CARTELLA_DATI.glob("*.json") if p.name != "index.json")

    impianti_visti = 0
    prezzi_visti = 0
    carburanti_trovati = set()

    for percorso in file_province:
        documento = json.loads(percorso.read_text(encoding="utf-8"))

        if not documento["impianti"]:
            problemi += errore(f"{percorso.name} non contiene nessun impianto")
            continue

        for impianto in documento["impianti"]:
            impianti_visti += 1

            # Senza coordinate valide il pulsante "portami li" manderebbe nel vuoto
            if not (35.0 <= impianto["lat"] <= 47.2 and 6.0 <= impianto["lon"] <= 19.0):
                problemi += errore(f"{percorso.name}: impianto {impianto['id']} fuori dall'Italia")

            if not impianto["prezzi"]:
                problemi += errore(f"{percorso.name}: impianto {impianto['id']} senza prezzi")

            for carburante, modalita in impianto["prezzi"].items():
                carburanti_trovati.add(carburante)

                for nome_modalita, valore in modalita.items():
                    prezzi_visti += 1

                    if nome_modalita not in ("self", "servito"):
                        problemi += errore(f"modalita' sconosciuta: {nome_modalita}")

                    minimo, massimo = LIMITI_PREZZO[carburante]
                    if not minimo <= valore <= massimo:
                        problemi += errore(
                            f"{percorso.name}: prezzo assurdo {valore} "
                            f"({carburante} {nome_modalita}, impianto {impianto['id']})"
                        )

    print(f"  file provincia letti: {len(file_province)}")
    print(f"  impianti controllati: {impianti_visti}")
    print(f"  prezzi controllati: {prezzi_visti}")
    print(f"  carburanti trovati: {sorted(carburanti_trovati)}")

    # Se sparisce una categoria intera, la normalizzazione si e' rotta
    mancanti = CARBURANTI_ATTESI - carburanti_trovati
    if mancanti:
        problemi += errore(f"non trovo nessun prezzo per: {sorted(mancanti)}")

    sconosciuti = carburanti_trovati - CARBURANTI_ATTESI
    if sconosciuti:
        problemi += errore(f"categorie di carburante inattese: {sorted(sconosciuti)}")

    return problemi


def main():
    print("Verifica dei dati costruiti")

    if not CARTELLA_DATI.exists():
        print("  FALLITO: la cartella web/data non esiste. Hai lanciato build_data.py?")
        sys.exit(1)

    print("\n1) Indice")
    problemi = verifica_indice()

    print("\n2) Impianti e prezzi")
    problemi += verifica_impianti()

    if problemi:
        print(f"\n{problemi} controlli falliti: non pubblico.")
        sys.exit(1)

    print("\nTutti i controlli superati.")


if __name__ == "__main__":
    main()
