import sys
import requests
import os
import re
import json
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
    db = client.get_database()
    youtube_channels_collection = db['youtubechannels']
    youtube_videos_collection = db['youtubeVideos']
    print("Connecté à MongoDB avec succès")
except ConnectionFailure as e:
    print(f"Erreur de connexion à MongoDB : {str(e)}")
    sys.exit(1)

# Chemins des fichiers relatifs au script
base_dir = os.path.dirname(__file__)

# Fonction pour écrire dans le fichier de log
def log_message(message):
    print(message)
    sys.stdout.flush()

# Fonction pour vérifier la validité du jeton OAuth
def validate_access_token(access_token):
    """Vérifie la validité du jeton OAuth en interrogeant l'API YouTube."""
    if not access_token:
        log_message("Erreur : Aucun jeton d'accès fourni")
        return False
    try:
        url = "https://www.googleapis.com/oauth2/v3/tokeninfo"
        params = {"access_token": access_token}
        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()
        token_info = response.json()
        
        if 'error' in token_info or 'error_description' in token_info:
            log_message(f"Erreur : Jeton d'accès invalide - {token_info.get('error_description', 'Erreur non spécifiée')}")
            log_message(f"Détails complets de la réponse : {json.dumps(token_info, indent=2)}")
            return False
        
        if 'expires_in' in token_info:
            try:
                expires_in = int(token_info['expires_in'])
                if expires_in > 0:
                    return True
                else:
                    log_message("Erreur : Jeton d'accès expiré (expires_in <= 0)")
                    return False
            except ValueError:
                log_message(f"Erreur : Impossible de convertir expires_in en entier : {token_info['expires_in']}")
                return False
        else:
            log_message("Erreur : Champ 'expires_in' manquant dans la réponse de validation")
            return False
    except requests.exceptions.RequestException as e:
        log_message(f"Erreur lors de la validation du jeton d'accès : {str(e)}")
        if e.response:
            log_message(f"Code de statut de la validation : {e.response.status_code}, Réponse : {e.response.text[:500]}")
        return False

def process_url(channel_data, session, access_token):
    """Traite une URL de chaîne /streams avec parsing robuste (JSON + fallback regex)"""
    results = []
    channel_id = channel_data.get('channelId', '')
    if not channel_id:
        log_message(f"channelId manquant pour {channel_data}")
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams?ucbcb=1"

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            "Authorization": f"Bearer {access_token}",
            "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
        }

        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        html_content = response.text

        # Détection page de consentement
        if any(x in html_content for x in ["Avant d'accéder à YouTube", "Bevor Sie zu YouTube weitergehen", "Before you continue to YouTube"]):
            log_message(f"Page de consentement détectée pour {url}")
            return results

        channel_name = channel_data.get('title', 'Unknown')
        ch_thumbnail = channel_data.get('thumbnail', '')

        # ====================== 1. ESSAI AVEC ytInitialData (RECOMMANDÉ) ======================
        json_match = re.search(r'var ytInitialData\s*=\s*(\{.*?\});\s*</script>', html_content, re.DOTALL)
        if json_match:
            try:
                data = json.loads(json_match.group(1))
                extracted = extract_from_ytinitialdata(data, url, channel_name, ch_thumbnail)
                if extracted:
                    results.extend(extracted)
                    log_message(f"{len(extracted)} vidéos extraites via ytInitialData pour {channel_name}")
                    return results  # Si JSON a fonctionné → on sort
            except Exception as e:
                log_message(f"Erreur parsing ytInitialData pour {channel_name}: {e}")

        # ====================== 2. FALLBACK : Regex (si JSON échoue) ======================
        log_message(f"ytInitialData non trouvé ou invalide → fallback regex pour {channel_name}")

        # Channel name depuis <title>
        title_match = re.search(r'<title>(.*?)</title>', html_content, re.DOTALL)
        if title_match:
            raw = title_match.group(1).strip()
            channel_name = re.sub(r'\s*-\s*YouTube.*$', '', raw, flags=re.IGNORECASE).strip()

        # === UPCOMING ===
        upcoming_positions = [m.start() for m in re.finditer(r'"upcomingEventData"', html_content)]
        for pos in upcoming_positions:
            segment = html_content[max(0, pos - 5000):pos + 800]

            video_id_match = re.search(r'"videoId":"([A-Za-z0-9_-]{11})"', segment)
            start_time_match = re.search(r'"startTime":"(\d+)"', segment)
            thumbnail_match = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)

            # Titre (plusieurs formats possibles)
            title_match = re.search(
                r'"title"\s*:\s*(?:{"simpleText":"([^"]+?)"|{"runs":\[{"text":"([^"]+?)"})',
                segment
            )
            title = ""
            if title_match:
                title = title_match.group(1) or title_match.group(2) or ""

            if video_id_match and title and start_time_match:
                results.append({
                    "vidUrl": f"https://www.youtube.com/watch?v={video_id_match.group(1)}",
                    "vidTitle": title,
                    "vidThumbnail": thumbnail_match.group(1) if thumbnail_match else "",
                    "startTime": start_time_match.group(1),
                    "chUrl": url,
                    "chTitle": channel_name,
                    "chThumbnail": ch_thumbnail,
                    "status": "upcoming",
                    "timestamp": datetime.now().isoformat()
                })

# === LIVE - Correction importante ===
        live_positions = [m.start() for m in re.finditer(r'"style":"LIVE"', html_content)]
        for pos in live_positions:
            # Segment plus ciblé pour éviter de capturer les Upcoming au-dessus
            segment = html_content[max(0, pos - 7000):pos + 600]

            # On prend le DERNIER videoId avant le badge "LIVE" (le plus proche)
            video_ids = re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"', segment)
            video_id = video_ids[-1] if video_ids else None

            if not video_id:
                continue

            title_match = re.search(
                r'"title"\s*:\s*(?:{"simpleText":"([^"]+?)"|{"runs":\[{"text":"([^"]+?)"})',
                segment
            )
            title = title_match.group(1) or title_match.group(2) if title_match else ""

            thumbnail_match = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)

            viewer_match = re.search(
                r'"viewCountText"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]+?)"', 
                segment
            )
            viewer_count = 0
            if viewer_match:
                num_str = re.sub(r'[^0-9]', '', viewer_match.group(1))
                viewer_count = int(num_str) if num_str else 0

            if video_id and title:
                results.append({
                    "vidUrl": f"https://www.youtube.com/watch?v={video_id}",
                    "vidTitle": title,
                    "vidThumbnail": thumbnail_match.group(1) if thumbnail_match else "",
                    "startTime": str(int(time.time())),
                    "chUrl": url,
                    "chTitle": channel_name,
                    "chThumbnail": ch_thumbnail,
                    "status": "live",
                    "viewer_count": viewer_count,
                    "timestamp": datetime.now().isoformat()
                })
                
        upcoming_count = sum(1 for r in results if r["status"] == "upcoming")
        live_count = sum(1 for r in results if r["status"] == "live")
        log_message(f"{channel_name} → {len(results)} vidéos (upcoming: {upcoming_count}, live: {live_count})")

        return results

    except requests.exceptions.RequestException as e:
        log_message(f"Erreur requête pour {url}: {str(e)}")
        if getattr(e, 'response', None):
            log_message(f"Status: {e.response.status_code}")
        return results
    except Exception as e:
        log_message(f"Erreur inattendue pour {url}: {str(e)}")
        return results


# ====================== FONCTION JSON (la plus fiable) ======================
def extract_from_ytinitialdata(data, url, channel_name, ch_thumbnail):
    """Extrait les lives et upcoming depuis ytInitialData"""
    results = []

    try:
        # Navigation dans la structure actuelle (avril 2026)
        tabs = data.get('contents', {}).get('twoColumnBrowseResultsRenderer', {}).get('tabs', [])
        for tab in tabs:
            content = tab.get('tabRenderer', {}).get('content', {})
            grid = content.get('richGridRenderer', {}).get('contents', [])
            if grid:
                break
        else:
            return results

        for item in grid:
            if 'richItemRenderer' not in item:
                continue

            video = item['richItemRenderer'].get('content', {}).get('videoRenderer')
            if not video:
                continue

            video_id = video.get('videoId')
            if not video_id:
                continue

            # Titre
            title_runs = video.get('title', {})
            title = title_runs.get('simpleText') or (
                title_runs.get('runs', [{}])[0].get('text') if title_runs.get('runs') else ''
            )

            # Thumbnail
            thumbnails = video.get('thumbnail', {}).get('thumbnails', [])
            thumbnail = thumbnails[0].get('url', '') if thumbnails else ''

            # === UPCOMING ===
            if 'upcomingEventData' in video:
                start_time = video['upcomingEventData'].get('startTime')
                if start_time:
                    results.append({
                        "vidUrl": f"https://www.youtube.com/watch?v={video_id}",
                        "vidTitle": title,
                        "vidThumbnail": thumbnail,
                        "startTime": start_time,
                        "chUrl": url,
                        "chTitle": channel_name,
                        "chThumbnail": ch_thumbnail,
                        "status": "upcoming",
                        "timestamp": datetime.now().isoformat()
                    })

            # === LIVE ===
            elif any(badge.get('liveBadgeRenderer') for badge in video.get('badges', [])):
                # Viewer count
                view_text = video.get('viewCountText', {})
                viewer_str = view_text.get('simpleText') or (
                    view_text.get('runs', [{}])[0].get('text') if view_text.get('runs') else ''
                )
                viewer_count = int(re.sub(r'[^0-9]', '', viewer_str)) if viewer_str else 0

                results.append({
                    "vidUrl": f"https://www.youtube.com/watch?v={video_id}",
                    "vidTitle": title,
                    "vidThumbnail": thumbnail,
                    "startTime": str(int(time.time())),
                    "chUrl": url,
                    "chTitle": channel_name,
                    "chThumbnail": ch_thumbnail,
                    "status": "live",
                    "viewer_count": viewer_count,
                    "timestamp": datetime.now().isoformat()
                })

    except Exception as e:
        log_message(f"Erreur dans extract_from_ytinitialdata: {e}")

    return results

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True, help='YouTube OAuth access token')
    args = parser.parse_args()
    access_token = args.access_token

    if not validate_access_token(access_token):
        log_message("Erreur : Le jeton d'accès est invalide ou non vérifiable, abandon de l'exécution")
        sys.exit(1)

    start_time = time.time()
    try:
        channels = list(youtube_channels_collection.find({}))
        log_message(f"{len(channels)} chaînes lues depuis la collection 'youtubechannels'")

        video_results = []
        with requests.Session() as session:
            with ThreadPoolExecutor(max_workers=10) as executor:
                future_to_channel = {executor.submit(process_url, channel_data, session, access_token): channel_data for channel_data in channels}
                for future in as_completed(future_to_channel):
                    channel_videos = future.result()
                    video_results.extend(channel_videos)

        if video_results:
            youtube_videos_collection.delete_many({})
            youtube_videos_collection.insert_many(video_results)
            log_message(f"{len(video_results)} vidéos insérées dans la collection 'youtubeVideos'")
        else:
            log_message("Aucune vidéo à insérer dans 'youtubeVideos'")

        upcoming_total = sum(1 for r in video_results if r["status"] == "upcoming")
        live_total = sum(1 for r in video_results if r["status"] == "live")
        log_message(f"Nombre total de vidéos : {len(video_results)} (upcoming: {upcoming_total}, live: {live_total})")
        log_message(f"Temps d'exécution : {time.time() - start_time:.2f} secondes")

    except OperationFailure as e:
        log_message(f"Erreur MongoDB : {e}")
        sys.exit(1)
    except Exception as e:
        log_message(f"Erreur générale : {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
