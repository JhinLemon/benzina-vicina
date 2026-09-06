"""Scarica i CSV pubblici del MIMIT e produce un file JSON per ogni provincia.

Questo script gira una volta al giorno su GitHub Actions. Fa tutto il lavoro sporco
(scaricare 7 MB, unire, normalizzare, scartare) una volta sola, così il telefono
deve solo leggere un JSON già pronto.

Uso:  uv run scripts/build_data.py
"""

import csv
import json
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

# I file del ministero riportano orari italiani, senza dirlo. Scriverlo qui rende
# esplicito un pezzo di informazione che altrimenti resterebbe solo sottinteso,
# e serve davvero: GitHub Actions gira in UTC, dove "oggi" puo' essere un altro giorno.
FUSO_ITALIA = ZoneInfo("Europe/Rome")

URL_ANAGRAFICA = "https://www.mimit.gov.it/images/exportCSV/anagrafica_impianti_attivi.csv"
URL_PREZZI = "https://www.mimit.gov.it/images/exportCSV/prezzo_alle_8.csv"

# I dati stanno dentro web/ perche' web/ e' esattamente cio' che viene pubblicato:
# cosi' il sito funziona identico in locale e online, senza assemblare niente.
CARTELLA_DATI = Path(__file__).parent.parent / "web" / "data"

# Rettangolo che contiene l'Italia. Alcuni record hanno coordinate a 0, vuote o
# invertite: se cadono fuori da qui sono errori nel dato del ministero, non posti veri.
LAT_MIN, LAT_MAX = 35.0, 47.2
LON_MIN, LON_MAX = 6.0, 19.0

# Un prezzo comunicato mesi fa non è un prezzo: ti fa fare 15 km per niente.
GIORNI_MAX_PREZZO = 7

# Limiti di buonsenso, uno per carburante: un prezzo plausibile per il GPL (0,75)
# sarebbe assurdo per la benzina, quindi un limite unico non filtra niente.
# Sono larghi apposta: devono scartare i valori segnaposto (il classico 4,999 che
# mette chi il carburante non lo vende) senza buttare via prezzi veri ma insoliti.
LIMITI_PREZZO = {
    "benzina": (1.3, 3.0),
    "gasolio": (1.3, 3.0),
    "gpl": (0.4, 1.6),
    "metano": (0.9, 3.0),
}

# I controlli si fanno IN QUEST'ORDINE e ci si ferma al primo che risponde.
# L'ordine non è estetico: "GP DIESEL" e "Diesel Shell V Power" contengono "diesel"
# e vanno nel gasolio, mentre "V-Power" da solo è benzina. Chi è più specifico passa prima.
REGOLE_CARBURANTE = [
    ("gpl", ["gpl"]),
    ("metano", ["metano", "gnc", "gnl"]),
    ("gasolio", ["gasolio", "diesel", "hvo"]),
    ("benzina", ["benzina", "super", "verde", "v-power", "perform", "f101", "f-101"]),
]

# Le catene vere. Tutto il resto (marchi locali, distributori indipendenti) finisce
# in "Altro": un menu a tendina con 300 voci non lo usa nessuno.
BANDIERE_NOTE = [
    "Agip Eni",
    "Api-Ip",
    "Q8",
    "Esso",
    "Tamoil",
    "Shell",
    "Pompe Bianche",
    "Europam",
    "Retitalia",
    "Beyfin",
    "Energas",
    "Vega",
    "Ala",
    "Costantin",
    "Sarni Oil",
]


def scarica(url):
    """Scarica un file di testo e lo restituisce come stringa.

    I file del ministero non sono UTF-8 puliti: senza errors="replace" il download
    esplode su qualche carattere sbagliato invece di andare avanti.
    """
    print(f"  scarico {url.split('/')[-1]} ...")
    with urllib.request.urlopen(url, timeout=120) as risposta:
        grezzo = risposta.read()
    return grezzo.decode("utf-8", errors="replace")


def pulisci(testo):
    """Toglie spazi, tabulazioni e spazi doppi da un campo di testo.

    I nomi impianto contengono tabulazioni in mezzo alle parole (es. "19834\tMONTALLEGRO"):
    .split() senza argomenti spezza su qualsiasi spazio bianco, poi li riunisco con uno solo.
    """
    return " ".join(testo.split())


def leggi_csv_mimit(testo):
    """Legge un CSV del MIMIT e restituisce (data_estrazione, lista_di_dizionari).

    Questi file hanno una struttura tutta loro: la riga 1 è "Estrazione del AAAA-MM-GG",
    la riga 2 è l'intestazione vera, e il separatore è "|" (dal 10/02/2026, prima era la virgola).
    """
    righe = testo.splitlines()

    # riga 1: "Estrazione del 2026-09-03" -> tengo solo l'ultima parola
    data_estrazione = righe[0].split()[-1]

    lettore = csv.DictReader(righe[1:], delimiter="|")
    return data_estrazione, list(lettore)


def categoria_carburante(descrizione):
    """Trasforma una descrizione commerciale in (categoria, è_premium).

    Nel dato reale ci sono 58 varianti diverse: "Blue Diesel", "HVOlution", "Supreme Diesel",
    "Benzina WR 100"... Le riduco a 4 categorie confrontabili.

    Premium = tutto ciò che non è il prodotto base. Confrontare un V-Power con una benzina
    normale non è un confronto: costano diverso perché sono cose diverse.
    """
    testo = descrizione.lower().strip()

    for categoria, sottostringhe in REGOLE_CARBURANTE:
        for pezzo in sottostringhe:
            if pezzo in testo:
                # è "base" solo se la descrizione è esattamente il nome della categoria
                premium = testo != categoria
                return categoria, premium

    # Non riconosciuto: lo tratto come benzina premium, così esiste nel dato
    # ma resta fuori dai confronti finché non capisco cos'è.
    return "benzina", True


def gruppo_bandiera(bandiera):
    """Il gruppo serve SOLO a filtrare: riduce centinaia di marchi a una quindicina.

    Il nome vero della bandiera resta nel campo `bandiera` e si continua a mostrare:
    all'utente "Cda" dice qualcosa, "Altro" no. Sono due lavori diversi e vanno
    tenuti separati — uno per il menu a tendina, uno per la riga della lista.
    """
    pulita = pulisci(bandiera)
    if pulita in BANDIERE_NOTE:
        return pulita
    return "Altro"


def coordinate_valide(lat, lon):
    """Controlla che il punto cada dentro il rettangolo dell'Italia."""
    return LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX


def carica_impianti(testo):
    """Legge l'anagrafica e restituisce {id_impianto: dati_impianto}.

    Uso un dizionario con l'id come chiave perché subito dopo devo agganciarci i prezzi:
    cercare in un dizionario è immediato, scorrere una lista di 24.000 elementi per ogni
    prezzo (93.000 prezzi) significherebbe due miliardi di confronti.
    """
    data_estrazione, righe = leggi_csv_mimit(testo)

    impianti = {}
    scartati_coordinate = 0
    scartati_rotti = 0

    for riga in righe:
        try:
            id_impianto = int(riga["idImpianto"])
            lat = float(riga["Latitudine"])
            lon = float(riga["Longitudine"])
        except (ValueError, TypeError, KeyError):
            # riga incompleta o con numeri non numerici: non recuperabile, la salto
            scartati_rotti += 1
            continue

        if not coordinate_valide(lat, lon):
            scartati_coordinate += 1
            continue

        impianti[id_impianto] = {
            "id": id_impianto,
            "nome": pulisci(riga["Nome Impianto"]),
            "bandiera": pulisci(riga["Bandiera"]),
            "gruppo": gruppo_bandiera(riga["Bandiera"]),
            "tipo": pulisci(riga["Tipo Impianto"]),
            "indirizzo": pulisci(riga["Indirizzo"]),
            "comune": pulisci(riga["Comune"]),
            "provincia": pulisci(riga["Provincia"]).upper(),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "prezzi": {},
            "aggiornato": None,
        }

    print(f"  impianti letti: {len(impianti)}")
    print(f"    scartati per coordinate fuori Italia: {scartati_coordinate}")
    print(f"    scartati per riga rotta: {scartati_rotti}")
    return data_estrazione, impianti


def aggiungi_prezzi(testo, impianti, data_estrazione):
    """Aggancia i prezzi agli impianti. Modifica il dizionario impianti sul posto."""
    _, righe = leggi_csv_mimit(testo)

    estrazione = datetime.strptime(data_estrazione, "%Y-%m-%d").replace(tzinfo=FUSO_ITALIA)
    limite = estrazione - timedelta(days=GIORNI_MAX_PREZZO)

    contatori = {
        "tenuti": 0,
        "premium": 0,
        "vecchi": 0,
        "senza_impianto": 0,
        "rotti": 0,
        "fuori_scala": 0,
    }

    for riga in righe:
        try:
            id_impianto = int(riga["idImpianto"])
            prezzo = float(riga["prezzo"])
            # dtComu è in formato italiano (gg/mm/aaaa), non ISO: strptime va istruito
            comunicato = datetime.strptime(riga["dtComu"], "%d/%m/%Y %H:%M:%S").replace(
                tzinfo=FUSO_ITALIA
            )
        except (ValueError, TypeError, KeyError):
            contatori["rotti"] += 1
            continue

        # inner join: se l'id non è in anagrafica il prezzo non ha un posto dove stare
        impianto = impianti.get(id_impianto)
        if impianto is None:
            contatori["senza_impianto"] += 1
            continue

        if comunicato < limite:
            contatori["vecchi"] += 1
            continue

        categoria, premium = categoria_carburante(riga["descCarburante"])
        if premium:
            contatori["premium"] += 1
            continue

        # Il controllo sul prezzo va DOPO aver capito che carburante e', perche'
        # i limiti dipendono dal carburante.
        minimo, massimo = LIMITI_PREZZO[categoria]
        if not minimo <= prezzo <= massimo:
            contatori["fuori_scala"] += 1
            continue

        # isSelf: 1 = self service, 0 = servito. Mescolarli falsa tutto,
        # perché il servito costa 30-40 centesimi in più a parità di carburante.
        modalita = "self" if riga["isSelf"].strip() == "1" else "servito"

        prezzi_categoria = impianto["prezzi"].setdefault(categoria, {})

        # Lo stesso impianto può aver comunicato lo stesso prezzo più volte:
        # tengo solo il più recente, altrimenti l'ordine del file deciderebbe il prezzo.
        precedente = prezzi_categoria.get(modalita)
        if precedente is None or comunicato > datetime.fromisoformat(precedente["ts"]):
            prezzi_categoria[modalita] = {"valore": prezzo, "ts": comunicato.isoformat()}
            contatori["tenuti"] += 1

    print(f"  prezzi tenuti: {contatori['tenuti']}")
    print(f"    scartati perche premium: {contatori['premium']}")
    print(f"    scartati perche piu vecchi di {GIORNI_MAX_PREZZO} giorni: {contatori['vecchi']}")
    print(f"    scartati perche l'impianto non e in anagrafica: {contatori['senza_impianto']}")
    print(f"    scartati perche il prezzo e fuori scala: {contatori['fuori_scala']}")
    print(f"    scartati perche la riga e rotta: {contatori['rotti']}")


def semplifica_prezzi(impianto):
    """Appiattisce la struttura di lavoro nel formato finale del JSON.

    Durante il calcolo ogni prezzo si porta dietro il timestamp, che serve per scegliere
    il più recente. Nel file finale il timestamp non serve più prezzo per prezzo: basta
    la data più recente dell'impianto, che è quella che mostro all'utente.
    """
    prezzi_finali = {}
    piu_recente = None

    for categoria, modalita in impianto["prezzi"].items():
        prezzi_finali[categoria] = {}
        for nome_modalita, dato in modalita.items():
            prezzi_finali[categoria][nome_modalita] = dato["valore"]

            momento = datetime.fromisoformat(dato["ts"])
            if piu_recente is None or momento > piu_recente:
                piu_recente = momento

    impianto["prezzi"] = prezzi_finali
    impianto["aggiornato"] = piu_recente.date().isoformat() if piu_recente else None


def scrivi_json(percorso, contenuto):
    """Scrive un JSON compatto e ordinato.

    sort_keys e separators non sono estetica: questi file vengono ricommittati ogni
    giorno da GitHub Actions, e un ordine stabile fa sì che il diff mostri solo i
    prezzi cambiati davvero invece di righe rimescolate a caso.
    """
    percorso.write_text(
        json.dumps(contenuto, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )


def main():
    print("Benzina Vicina - costruzione dati")

    print("\n1) Download")
    testo_anagrafica = scarica(URL_ANAGRAFICA)
    testo_prezzi = scarica(URL_PREZZI)

    print("\n2) Anagrafica")
    data_estrazione, impianti = carica_impianti(testo_anagrafica)
    print(f"  estrazione del {data_estrazione}")

    print("\n3) Prezzi")
    aggiungi_prezzi(testo_prezzi, impianti, data_estrazione)

    print("\n4) Raggruppamento per provincia")
    per_provincia = {}
    senza_prezzi = 0

    for impianto in impianti.values():
        # Un impianto senza nemmeno un prezzo valido non serve a niente in una app
        # che confronta prezzi: lo tolgo qui, non nell'interfaccia.
        if not impianto["prezzi"]:
            senza_prezzi += 1
            continue

        semplifica_prezzi(impianto)
        provincia = impianto.pop("provincia")
        per_provincia.setdefault(provincia, []).append(impianto)

    print(f"  impianti senza prezzi validi (scartati): {senza_prezzi}")
    print(f"  province con almeno un impianto: {len(per_provincia)}")

    print("\n5) Scrittura file")
    CARTELLA_DATI.mkdir(exist_ok=True)

    # Cancello i JSON del giorno prima: se una provincia sparisce dal dato,
    # il suo file vecchio resterebbe lì a mentire.
    for vecchio in CARTELLA_DATI.glob("*.json"):
        vecchio.unlink()

    indice_province = []

    for provincia, elenco in sorted(per_provincia.items()):
        elenco.sort(key=lambda i: i["id"])

        scrivi_json(
            CARTELLA_DATI / f"{provincia}.json",
            {"estrazione": data_estrazione, "provincia": provincia, "impianti": elenco},
        )

        # Il centro della provincia è la media delle coordinate dei suoi impianti.
        # Non è il capoluogo geografico, ma serve solo a capire quali province
        # sono vicine a te: per quello è abbastanza preciso e non costa dati esterni.
        indice_province.append(
            {
                "provincia": provincia,
                "impianti": len(elenco),
                "lat": round(sum(i["lat"] for i in elenco) / len(elenco), 4),
                "lon": round(sum(i["lon"] for i in elenco) / len(elenco), 4),
            }
        )

    scrivi_json(
        CARTELLA_DATI / "index.json",
        {"estrazione": data_estrazione, "province": indice_province},
    )

    totale = sum(p["impianti"] for p in indice_province)
    print(f"  scritti {len(indice_province)} file provincia + index.json")
    print(f"  totale impianti pubblicati: {totale}")
    print("\nFatto.")


if __name__ == "__main__":
    main()
