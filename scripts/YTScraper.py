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

sys.stdout.reconfigure(encoding='utf-8')

load_dotenv()

MONGODB_URI = os.getenv('MONGODB_URI')
if not MONGODB_URI:
    print("Erreur : MONGODB_URI manquant dans .env")
    sys.exit(1)

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
    results = []
    channel_id = channel_data.get('channelId', '')
    channel_title = channel_data.get('title', 'Unknown')
    
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
        html = response.text

        log_message(f"   📏 Taille HTML : {len(html):,} caractères")

        if any(x in html.lower() for x in ["consent.youtube.com", "avant d'accéder", "before you continue"]):
            log_message(f"   ❌ Consentement détecté")
            return results

        upcoming_count = len(re.findall(r'upcomingEventData', html))
        live_count = len(re.findall(r'"style":"LIVE"', html))
        log_message(f"   🔍 upcoming: {upcoming_count} | LIVE: {live_count}")

        # ==================== UPCOMING ====================
        for m in re.finditer(r'"upcomingEventData"', html):
            pos = m.start()
            segment = html[max(0, pos-9000):pos+4000]

            start_time_m = re.search(r'"startTime":"(\d+)"', segment)
            title_m = re.search(r'"title":\s*[^}]*?"text":"([^"]+)"', segment)
            video_id_m = re.search(r'"videoId":"([A-Za-z0-9_-]+)"', segment)
            
            # Meilleur regex pour thumbnail vidéo
            thumb_m = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)

            if start_time_m and title_m and video_id_m:
                results.append({
                    "vidUrl": f"https://www.youtube.com/watch?v={video_id_m.group(1)}",
                    "vidTitle": title_m.group(1),
                    "vidThumbnail": thumb_m.group(1) if thumb_m else "",
                    "startTime": start_time_m.group(1),
                    "chUrl": url,
                    "chTitle": channel_title,
                    "chThumbnail": channel_data.get('thumbnail', ''),
                    "status": "upcoming",
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f"   ✅ Upcoming : {title_m.group(1)[:60]}")

        # ==================== LIVE ====================
        for m in re.finditer(r'"style":"LIVE"', html):
            pos = m.start()
            segment = html[max(0, pos-19000):pos+5000]

            title_m = re.search(r'"title":\s*[^}]*?"text":"([^"]+)"', segment)
            video_id_m = re.search(r'"videoId":"([A-Za-z0-9_-]+)"', segment)
            thumb_m = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)
            vc_m = re.search(r'viewCountText[^}]*?([\d\s,]+)', segment)

            if title_m and video_id_m:
                viewer_count = int(''.join(filter(str.isdigit, vc_m.group(1)))) if vc_m else 0
                results.append({
                    "vidUrl": f"https://www.youtube.com/watch?v={video_id_m.group(1)}",
                    "vidTitle": title_m.group(1),
                    "vidThumbnail": thumb_m.group(1) if thumb_m else "",
                    "startTime": str(int(time.time())),
                    "chUrl": url,
                    "chTitle": channel_title,
                    "chThumbnail": channel_data.get('thumbnail', ''),
                    "status": "live",
                    "viewer_count": viewer_count,
                    "timestamp": datetime.now().isoformat()
                })
                log_message(f"   ✅ Live : {title_m.group(1)[:60]}...")

        log_message(f"   📊 {len(results)} vidéos extraites")
        return results

    except Exception as e:
        log_message(f"   ❌ Erreur {channel_title} : {e}")
        return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True)
    args = parser.parse_args()

    if not validate_access_token(args.access_token):   # ← fonction manquante corrigée plus bas
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
        log_message(f"✅ {len(video_results)} vidéos sauvegardées")
    else:
        log_message("❌ Aucune vidéo trouvée")

# Fonction de validation du token (ajoutée)
def validate_access_token(access_token):
    try:
        r = requests.get("https://www.googleapis.com/oauth2/v3/tokeninfo", 
                        params={"access_token": access_token}, timeout=10)
        r.raise_for_status()
        data = r.json()
        expires = int(data.get('expires_in', 0))
        log_message(f"✅ Token valide ({expires}s restant)")
        return expires > 0
    except Exception as e:
        log_message(f"❌ Token invalide : {e}")
        return False


if __name__ == '__main__':
    main()
