import sys
import requests
import os
import re
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import argparse
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, OperationFailure

# Forcer l'encodage UTF-8 pour stdout et stderr
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# Charger les variables d'environnement depuis .env
load_dotenv()

# URI MongoDB depuis .env
MONGODB_URI = os.getenv('MONGODB_URI')
if not MONGODB_URI:
    print("Erreur : MONGODB_URI manquant dans .env")
    sys.exit(1)

# Connexion à MongoDB
try:
    client = MongoClient(MONGODB_URI)
    db = client.get_database()  # Le nom de la base est dans l'URI
    youtube_channels_collection = db['youtubechannels']
    youtube_videos_collection = db['youtubeVideos']
    print("Connecté à MongoDB avec succès")
except ConnectionFailure as e:
    print(f"Erreur de connexion à MongoDB : {str(e)}")
    sys.exit(1)

# Chemins des fichiers relatifs au script
base_dir = os.path.dirname(__file__)
log_file = os.path.join(base_dir, 'pyLog.txt')
error_html_dir = os.path.join(base_dir, '..', 'ErrorHTML')

# Créer le répertoire error_html_dir si nécessaire
os.makedirs(error_html_dir, exist_ok=True)

# Fonction pour écrire dans le fichier de log
def log_message(message):
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with open(log_file, 'a', encoding='utf-8') as f:
        f.write(f"{timestamp} - {message}\n")
    print(f"{timestamp} - {message}")
    sys.stdout.flush()

def process_url(channel_data, session, access_token):
    """Traite une URL, extrait les vidéos avec jeton OAuth."""
    results = []
    channel_id = channel_data.get('channelId', '')
    if not channel_id:
        log_message(f"channelId manquant pour channel_data : {channel_data}")
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams"
    log_message(f"Débogage : Traitement de l'URL {url} pour la chaîne {channel_data.get('title', 'Unknown')} (ID: {channel_id})")

    try:
        # Ajouter le cookie CONSENT
        session.cookies.set("CONSENT", "YES+srp.gws-20210601-0-RC2.fr+FX+123", domain=".youtube.com")

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            "Authorization": f"Bearer {access_token}",
            "Accept-Language": "fr-FR,fr;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
        }
        log_message(f"Débogage : Envoi de la requête GET à {url}")
        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        html_content = response.text
        log_message(f"Débogage : Requête réussie pour {url}, taille du HTML : {len(html_content)} caractères")

        # Ajouter un délai de 0,5 seconde après la requête
        time.sleep(0.5)

        # Extraire le nom de la chaîne depuis <title>
        channel_name = channel_data.get('title', 'Unknown')
        title_match = re.search(r'<title>(.*?)</title>', html_content, re.DOTALL)
        if title_match:
            raw_title = title_match.group(1).strip()
            channel_name = re.sub(r'\s*-\s*YouTube\s*$', '', raw_title, flags=re.IGNORECASE)
            log_message(f"Débogage : Nom de la chaîne extrait : {channel_name}")
        else:
            log_message(f"Débogage : Aucun <title> trouvé dans le HTML pour {url}")

        # Extraire la vignette de la chaîne depuis channel_data
        ch_thumbnail = channel_data.get('thumbnail', '')
        log_message(f"Débogage : Vignette de la chaîne : {ch_thumbnail}")

        # Vérifier la présence de vidéos à venir
        upcoming_matches = [m.start() for m in re.finditer(r'"upcomingEventData"', html_content)]
        log_message(f"Débogage : {len(upcoming_matches)} segments 'upcomingEventData' trouvés pour {url}")
        channel_handle = channel_id

        # Traiter les vidéos à venir
        for upcoming_pos in upcoming_matches:
            log_message(f"Débogage : Analyse du segment upcoming à la position {upcoming_pos}")
            start_time_match = re.search(r'"startTime":"(\d+)"', html_content[upcoming_pos:upcoming_pos+100])
            if not start_time_match:
                log_message(f"Débogage : startTime non trouvé à la position {upcoming_pos} pour {url}")
                continue
            start_time = start_time_match.group(1)
            log_message(f"Débogage : startTime trouvé : {start_time}")

            title = ''
            video_thumbnail = ''
            video_url = ''
            search_start = max(0, upcoming_pos - 3000)
            segment_before = html_content[search_start:upcoming_pos]
            log_message(f"Débogage : Segment analysé pour le titre (taille : {len(segment_before)} caractères)")

            title_search = re.search(r'"title":(?:{"runs":\[{"text":"((?:[^"\\]|\\.)*?)"\}\]|{"simpleText":"((?:[^"\\]|\\.)*?)"}|{"accessibility":{"accessibilityData":{"label":"((?:[^"\\]|\\.)*?)"}}})', segment_before, re.DOTALL)
            if title_search:
                title = title_search.group(1) or title_search.group(2) or title_search.group(3)
                log_message(f"Débogage : Titre trouvé : {title}")
            else:
                log_message(f"Débogage : Titre non trouvé à la position {upcoming_pos} pour {url}")
                html_filename = f"{channel_handle}_{upcoming_pos}.html"
                html_filepath = os.path.join(error_html_dir, html_filename)
                try:
                    with open(html_filepath, 'w', encoding='utf-8') as html_file:
                        html_file.write(html_content)
                    log_message(f"Débogage : HTML enregistré dans {html_filepath} pour analyse")
                except Exception as e:
                    log_message(f"Débogage : Erreur lors de l'enregistrement du HTML dans {html_filepath} : {str(e)}")

            thumbnail_search = re.search(r'"thumbnails":\s*\[\s*{"url":"([^"]+)"', segment_before, re.DOTALL)
            if thumbnail_search:
                video_thumbnail = thumbnail_search.group(1)
                log_message(f"Débogage : Vignette vidéo trouvée : {video_thumbnail}")
            else:
                log_message(f"Débogage : Vignette vidéo non trouvée à la position {upcoming_pos}")

            video_id_search = re.search(r'"videoId":"([A-Za-z0-9_-]+)"', segment_before, re.DOTALL)
            if video_id_search:
                video_id = video_id_search.group(1)
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                log_message(f"Débogage : videoId trouvé : {video_id}, URL : {video_url}")
            else:
                log_message(f"Débogage : videoId non trouvé à la position {upcoming_pos}")

            if title and video_url and video_thumbnail:
                results.append({
                    "vidUrl": video_url,
                    "vidTitle": title,
                    "vidThumbnail": video_thumbnail,
                    "startTime": start_time,
                    "chUrl": url,
                    "chTitle": channel_name,
                    "chThumbnail": ch_thumbnail,
                    "status": "upcoming",
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f"Débogage : Vidéo upcoming ajoutée : {title}")

        # Vérifier la présence de vidéos en direct (live) avec "style":"LIVE"
        live_matches = [m.start() for m in re.finditer(r'"style":"LIVE"', html_content)]
        log_message(f"Débogage : {len(live_matches)} segments 'style:LIVE' trouvés pour {url}")

        for live_pos in live_matches:
            log_message(f"Débogage : Analyse du segment live à la position {live_pos}")
            title = ''
            video_thumbnail = ''
            video_url = ''
            search_start = max(0, live_pos - 10000)
            search_range = html_content[search_start:live_pos]
            log_message(f"Débogage : Segment analysé pour le titre live (taille : {len(search_range)} caractères)")

            title_search = re.search(r'"title":\s*(?:{"runs":\[{"text":"((?:[^"\\]|\\.)*?)"\}\]|{"simpleText":"((?:[^"\\]|\\.)*?)"}|{"accessibility":{"accessibilityData":{"label":"((?:[^"\\]|\\.)*?)"}}})', search_range, re.DOTALL)
            if title_search:
                title = title_search.group(1) or title_search.group(2) or title_search.group(3)
                if title:
                    try:
                        title = title.encode().decode('utf-8', errors='replace')
                        log_message(f"Débogage : Titre live trouvé : {title}")
                    except Exception as e:
                        log_message(f"Débogage : Erreur d'encodage du titre à la position {live_pos} : {str(e)}")
                        title = title.encode().decode('unicode_escape', errors='replace')
            else:
                log_message(f"Débogage : Titre live non trouvé à la position {live_pos} dans {search_start}-{live_pos} pour {url}")
                html_filename = f"{channel_handle}_live_{live_pos}.html"
                html_filepath = os.path.join(error_html_dir, html_filename)
                try:
                    with open(html_filepath, 'w', encoding='utf-8') as html_file:
                        html_file.write(html_content)
                    log_message(f"Débogage : HTML enregistré dans {html_filepath} pour analyse")
                except Exception as e:
                    log_message(f"Débogage : Erreur lors de l'enregistrement du HTML dans {html_filepath} : {str(e)}")

            thumbnail_search = re.search(r'"thumbnails":\s*\[\s*{"url":"([^"]+)"', search_range, re.DOTALL)
            if thumbnail_search:
                video_thumbnail = thumbnail_search.group(1)
                video_thumbnail = video_thumbnail.encode().decode('utf-8', errors='replace')
                log_message(f"Débogage : Vignette live trouvée : {video_thumbnail}")
            else:
                log_message(f"Débogage : Vignette live non trouvée à la position {live_pos}")

            video_ids = re.findall(r'"videoId":"([A-Za-z0-9_-]+)"', search_range)
            if video_ids:
                video_id = video_ids[-1]
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                log_message(f"Débogage : videoId live trouvé : {video_id}, URL : {video_url}")
                if re.search(r'"viewCountText":\s*{"runs":\[{"text":"[^"]+"},{"text":"watching"}]', search_range):
                    log_message(f"Débogage : Confirmation que {video_id} est une vidéo live")
                else:
                    log_message(f"Débogage : Attention : Le videoId {video_id} peut ne pas correspondre à une vidéo live à la position {live_pos}")
            else:
                log_message(f"Débogage : videoId live non trouvé à la position {live_pos} dans {search_start}-{live_pos} pour {url}")
                continue

            if title and video_url and video_thumbnail:
                results.append({
                    "vidUrl": video_url,
                    "vidTitle": title,
                    "vidThumbnail": video_thumbnail,
                    "startTime": str(int(time.time())),
                    "chUrl": url,
                    "chTitle": channel_name,
                    "chThumbnail": ch_thumbnail,
                    "status": "live",
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f"Débogage : Vidéo live ajoutée : {title}")

        upcoming_count = sum(1 for r in results if r["status"] == "upcoming")
        live_count = sum(1 for r in results if r["status"] == "live")
        if results:
            log_message(f"Résultat pour {channel_name} : {upcoming_count} upcoming, {live_count} live")
        else:
            log_message(f"Aucune vidéo trouvée pour {channel_name}")

        return results

    except requests.exceptions.RequestException as e:
        log_message(f"Erreur lors de la requête pour {url} : {str(e)}")
        if e.response:
            log_message(f"Code de statut : {e.response.status_code}, Réponse : {e.response.text[:500]}")
        return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True, help='YouTube OAuth access token')
    args = parser.parse_args()
    access_token = args.access_token

    start_time = time.time()
    try:
        # Lire les chaînes depuis la collection MongoDB
        channels = list(youtube_channels_collection.find({}))
        log_message(f"{len(channels)} chaînes lues depuis la collection 'youtubechannels'")
        for channel in channels:
            log_message(f"Débogage : Chaîne lue - ID: {channel.get('channelId')}, Titre: {channel.get('title')}")

        video_results = []
        with requests.Session() as session:
            with ThreadPoolExecutor(max_workers=10) as executor:
                future_to_channel = {executor.submit(process_url, channel_data, session, access_token): channel_data for channel_data in channels}
                for future in as_completed(future_to_channel):
                    channel_videos = future.result()
                    video_results.extend(channel_videos)

        # Insérer les résultats dans la collection MongoDB
        if video_results:
            youtube_videos_collection.delete_many({})  # Vider la collection avant insertion
            youtube_videos_collection.insert_many(video_results)
            log_message(f"{len(video_results)} vidéos insérées dans la collection 'youtubeVideos'")
        else:
            log_message("Aucune vidéo à insérer dans 'youtubeVideos'")

        upcoming_total = sum(1 for r in video_results if r["status"] == "upcoming")
        live_total = sum(1 for r in video_results if r["status"] == "live")
        log_message(f"Nombre total de vidéos trouvées : {len(video_results)} (upcoming: {upcoming_total}, live: {live_total})")
        log_message(f"Temps d'exécution : {time.time() - start_time:.2f} secondes")

    except OperationFailure as e:
        log_message(f"Erreur MongoDB : {str(e)}")
        sys.exit(1)
    except Exception as e:
        log_message(f"Erreur générale : {str(e)}")
        sys.exit(1)

if __name__ == "__main__":
    main()
