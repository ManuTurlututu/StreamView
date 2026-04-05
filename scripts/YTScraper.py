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
from pymongo.errors import ConnectionFailure

# Forcer l'encodage UTF-8
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# Charger les variables d'environnement
load_dotenv()

MONGODB_URI = os.getenv('MONGODB_URI')
if not MONGODB_URI:
    print("Erreur : MONGODB_URI manquant dans .env")
    sys.exit(1)

# Connexion MongoDB
try:
    client = MongoClient(MONGODB_URI)
    db = client.get_database()
    youtube_channels_collection = db['youtubechannels']
    youtube_videos_collection = db['youtubeVideos']
    print("✅ Connecté à MongoDB")
except ConnectionFailure as e:
    print(f"Erreur MongoDB : {e}")
    sys.exit(1)


def log_message(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")
    sys.stdout.flush()


def process_url(channel_data, session, access_token):
    """Traite une chaîne avec la méthode de recherche précise de l'ancien script
    (segments limités avant le marqueur + regex robustes) tout en gardant
    la structure, les logs et les headers du script récent."""
    results = []
    channel_id = channel_data.get('channelId', '')
    channel_title = channel_data.get('title', 'Unknown')
    ch_thumbnail = channel_data.get('thumbnail', '')

    if not channel_id:
        log_message(f"⚠️ channelId manquant pour {channel_title}")
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams?gl=US&hl=en"
    log_message(f"→ {channel_title}")

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
            "Authorization": f"Bearer {access_token}",
        }
        cookies = {
            "CONSENT": "YES+cb.20250403-00-p0.fr+FX+123",
            "SOCS": "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjUwNjAzLjAzX3AwGgJmciACGgYIgJn-wQY",
        }

        response = session.get(url, headers=headers, cookies=cookies, timeout=20)
        response.raise_for_status()
        html_content = response.text

        log_message(f" 📏 Taille HTML : {len(html_content):,} caractères")

        if any(x in html_content.lower() for x in ["consent.youtube.com", "avant d'accéder", "before you continue"]):
            log_message(f" ❌ Consentement détecté")
            return results

        upcoming_count = len(re.findall(r'upcomingEventData', html_content))
        live_count = len(re.findall(r'"style":"LIVE"', html_content))
        log_message(f" 🔍 upcoming: {upcoming_count} | LIVE: {live_count}")

        # ==================== UPCOMING (méthode ancienne ultra-précise) ====================
        upcoming_matches = [m.start() for m in re.finditer(r'"upcomingEventData"', html_content)]
        for upcoming_pos in upcoming_matches:
            # Recherche du startTime juste après le marqueur (comme dans l'ancien)
            start_time_match = re.search(r'"startTime":"(\d+)"', html_content[upcoming_pos:upcoming_pos + 1000])
            if not start_time_match:
                log_message(f"⚠️ startTime non trouvé à la position {upcoming_pos} pour {channel_title}")
                continue

            start_time = start_time_match.group(1)

            # Segment limité AVANT le marqueur (clé pour éviter le mélange des données)
            search_start = max(0, upcoming_pos - 5000)
            segment_before = html_content[search_start:upcoming_pos]

            title = ''
            video_thumbnail = ''
            video_url = ''

            # Regex robuste titre (exactement comme dans l'ancien script)
            title_search = re.search(
                r'"title":(?:{"runs":\[{"text":"((?:[^"\\]|\\.)*?)"\}\]|{"simpleText":"((?:[^"\\]|\\.)*?)"}|{"accessibility":{"accessibilityData":{"label":"((?:[^"\\]|\\.)*?)"}}})',
                segment_before, re.DOTALL
            )
            if title_search:
                title = title_search.group(1) or title_search.group(2) or title_search.group(3)

            # Thumbnail
            thumbnail_search = re.search(r'"thumbnails":\s*\[\s*{"url":"([^"]+)"', segment_before, re.DOTALL)
            if thumbnail_search:
                video_thumbnail = thumbnail_search.group(1)

            # videoId
            video_id_search = re.search(r'"videoId":"([A-Za-z0-9_-]+)"', segment_before, re.DOTALL)
            if video_id_search:
                video_id = video_id_search.group(1)
                video_url = f"https://www.youtube.com/watch?v={video_id}"

            if title and video_url:
                results.append({
                    "vidUrl": video_url,
                    "vidTitle": title,
                    "vidThumbnail": video_thumbnail,
                    "startTime": start_time,
                    "chUrl": url,
                    "chTitle": channel_title,
                    "chThumbnail": ch_thumbnail,
                    "status": "upcoming",
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f" ✅ Upcoming : {title[:60]}")
            else:
                log_message(f"⚠️ Données incomplètes pour upcoming à la position {upcoming_pos}")

        # ==================== LIVE (méthode ancienne ultra-précise) ====================
        live_matches = [m.start() for m in re.finditer(r'"style":"LIVE"', html_content)]
        for live_pos in live_matches:
            title = ''
            video_thumbnail = ''
            video_url = ''
            viewer_count = 0

            # Segment limité AVANT le marqueur "style":"LIVE"
            search_start = max(0, live_pos - 12000)
            search_range = html_content[search_start:live_pos]

            # Regex robuste titre (exactement comme dans l'ancien)
            title_search = re.search(
                r'"title":\s*(?:{"runs":\[{"text":"((?:[^"\\]|\\.)*?)"\}\]|{"simpleText":"((?:[^"\\]|\\.)*?)"}|{"accessibility":{"accessibilityData":{"label":"((?:[^"\\]|\\.)*?)"}}})',
                search_range, re.DOTALL
            )
            if title_search:
                title = title_search.group(1) or title_search.group(2) or title_search.group(3)

            # Thumbnail
            thumbnail_search = re.search(r'"thumbnails":\s*\[\s*{"url":"([^"]+)"', search_range, re.DOTALL)
            if thumbnail_search:
                video_thumbnail = thumbnail_search.group(1)

            # Dernier videoId avant le marqueur LIVE (très important pour éviter le mélange)
            video_ids = re.findall(r'"videoId":"([A-Za-z0-9_-]+)"', search_range)
            if video_ids:
                video_id = video_ids[-1]
                video_url = f"https://www.youtube.com/watch?v={video_id}"

                # Viewer count avec le regex précis de l'ancien script
                view_count_search = re.search(
                    r'"viewCountText":\s*{\s*"runs":\s*\[\s*{\s*"text":\s*"([\d\s ,]+)"\s*},\s*{\s*"text":\s*"[^"]*"\s*}\s*\]',
                    search_range, re.DOTALL
                )
                if view_count_search:
                    viewer_count_str = view_count_search.group(1)
                    viewer_count_str = ''.join(filter(str.isdigit, viewer_count_str))
                    viewer_count = int(viewer_count_str) if viewer_count_str else 0
            else:
                log_message(f"⚠️ Aucun videoId trouvé avant le marqueur LIVE à la position {live_pos}")
                continue

            if title and video_url:
                results.append({
                    "vidUrl": video_url,
                    "vidTitle": title,
                    "vidThumbnail": video_thumbnail,
                    "startTime": str(int(time.time())),
                    "chUrl": url,
                    "chTitle": channel_title,
                    "chThumbnail": ch_thumbnail,
                    "status": "live",
                    "viewer_count": viewer_count,
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f" ✅ Live : {title[:60]}...")

        log_message(f" 📊 {len(results)} vidéos extraites pour {channel_title}")
        return results

    except Exception as e:
        log_message(f" ❌ Erreur {channel_title} : {e}")
        return results


def validate_access_token(access_token):
    """Validation du token (version récente + logs améliorés)"""
    try:
        r = requests.get(
            "https://www.googleapis.com/oauth2/v3/tokeninfo",
            params={"access_token": access_token},
            timeout=10
        )
        r.raise_for_status()
        data = r.json()
        expires = int(data.get('expires_in', 0))
        log_message(f"✅ Token valide ({expires}s restant)")
        return expires > 0
    except Exception as e:
        log_message(f"❌ Token invalide : {e}")
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True)
    args = parser.parse_args()

    if not validate_access_token(args.access_token):
        sys.exit(1)

    channels = list(youtube_channels_collection.find({}))
    log_message(f"{len(channels)} chaînes chargées")

    video_results = []
    with requests.Session() as session:
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(process_url, ch, session, args.access_token): ch for ch in channels}
            for future in as_completed(futures):
                video_results.extend(future.result())

    if video_results:
        youtube_videos_collection.delete_many({})
        youtube_videos_collection.insert_many(video_results)
        log_message(f"✅ {len(video_results)} vidéos sauvegardées dans youtubeVideos")
    else:
        log_message("❌ Aucune vidéo trouvée")

    upcoming_total = sum(1 for r in video_results if r.get("status") == "upcoming")
    live_total = sum(1 for r in video_results if r.get("status") == "live")
    log_message(f"Total → {len(video_results)} vidéos (upcoming: {upcoming_total} | live: {live_total})")


if __name__ == '__main__':
    main()
