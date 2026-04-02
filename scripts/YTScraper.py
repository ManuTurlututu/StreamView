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

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

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
    print("Connecté à MongoDB avec succès")
except ConnectionFailure as e:
    print(f"Erreur de connexion à MongoDB : {str(e)}")
    sys.exit(1)

def log_message(message):
    print(message)
    sys.stdout.flush()

def validate_access_token(access_token):
    if not access_token:
        log_message("Erreur : Aucun jeton d'accès fourni")
        return False
    try:
        response = requests.get("https://www.googleapis.com/oauth2/v3/tokeninfo", 
                                params={"access_token": access_token}, timeout=10)
        response.raise_for_status()
        token_info = response.json()
        if 'error' in token_info:
            log_message(f"Erreur token : {token_info.get('error_description')}")
            return False
        return int(token_info.get('expires_in', 0)) > 0
    except Exception as e:
        log_message(f"Erreur validation token : {e}")
        return False


def process_url(channel_data, session, access_token):
    results = []
    channel_id = channel_data.get('channelId', '')
    if not channel_id:
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams?ucbcb=1"

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Authorization": f"Bearer {access_token}",
            "Accept-Language": "en-US,en;q=0.9",
        }

        response = session.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        html_content = response.text

        if any(x in html_content for x in ["Avant d'accéder à YouTube", "Before you continue to YouTube"]):
            log_message(f"Consent page pour {url}")
            return results

        channel_name = channel_data.get('title', 'Unknown')
        ch_thumbnail = channel_data.get('thumbnail', '')

        # 1. ytInitialData
        json_match = re.search(r'var ytInitialData\s*=\s*(\{.*?\});\s*</script>', html_content, re.DOTALL)
        if json_match:
            try:
                data = json.loads(json_match.group(1))
                extracted = extract_from_ytinitialdata(data, url, channel_name, ch_thumbnail)
                if extracted:
                    results.extend(extracted)
                    log_message(f"{len(extracted)} vidéos via ytInitialData pour {channel_name}")
                    return results
            except Exception as e:
                log_message(f"Erreur parsing ytInitialData pour {channel_name}: {e}")

        # 2. Fallback regex
        log_message(f"ytInitialData échoué → fallback regex pour {channel_name}")

        title_match = re.search(r'<title>(.*?)</title>', html_content, re.DOTALL)
        if title_match:
            channel_name = re.sub(r'\s*-\s*YouTube.*$', '', title_match.group(1).strip(), flags=re.IGNORECASE)

        # UPCOMING
        for pos in [m.start() for m in re.finditer(r'"upcomingEventData"', html_content)]:
            segment = html_content[max(0, pos - 5000):pos + 1000]
            video_id_match = re.search(r'"videoId":"([A-Za-z0-9_-]{11})"', segment)
            start_time_match = re.search(r'"startTime":"(\d+)"', segment)
            thumbnail_match = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)
            title_match = re.search(r'"title"\s*:\s*(?:{"simpleText":"([^"]+?)"|{"runs":\[{"text":"([^"]+?)"})', segment)

            title = title_match.group(1) or title_match.group(2) if title_match else ""
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

        # LIVE regex
        for pos in [m.start() for m in re.finditer(r'"style":"LIVE"', html_content)]:
            segment = html_content[max(0, pos - 5500):pos + 800]
            video_ids = re.findall(r'"videoId":"([A-Za-z0-9_-]{11})"', segment)
            video_id = video_ids[-1] if video_ids else None
            if not video_id: continue

            title_match = re.search(r'"title"\s*:\s*(?:{"simpleText":"([^"]+?)"|{"runs":\[{"text":"([^"]+?)"})', segment, re.DOTALL)
            title = title_match.group(1) or title_match.group(2) if title_match else ""

            thumbnail_match = re.search(r'"thumbnails":\s*\[\s*{"url":"(https?://[^"]+)"', segment)
            viewer_match = re.search(r'"viewCountText"\s*:\s*\{.*?"text"\s*:\s*"([^"]+?)"', segment, re.DOTALL)

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

        upcoming_count = sum(1 for r in results if r.get("status") == "upcoming")
        live_count = sum(1 for r in results if r.get("status") == "live")
        log_message(f"{channel_name} → {len(results)} vidéos (upcoming: {upcoming_count}, live: {live_count})")
        return results

    except Exception as e:
        log_message(f"Erreur pour {url}: {e}")
        return results


def extract_from_ytinitialdata(data, url, channel_name, ch_thumbnail):
    """Navigation renforcée + détection live indépendante"""
    results = []
    try:
        # Tentative 1 : navigation classique
        tabs = data.get('contents', {}).get('twoColumnBrowseResultsRenderer', {}).get('tabs', [])
        grid = []
        for tab in tabs:
            content = tab.get('tabRenderer', {}).get('content', {})
            grid = content.get('richGridRenderer', {}).get('contents', [])
            if grid:
                break

        # Tentative 2 : navigation alternative (souvent nécessaire)
        if not grid:
            grid = data.get('contents', {}).get('richGridRenderer', {}).get('contents', [])

        for item in grid:
            if 'richItemRenderer' not in item:
                continue
            video = item['richItemRenderer'].get('content', {}).get('videoRenderer')
            if not video or not video.get('videoId'):
                continue

            video_id = video.get('videoId')
            title = video.get('title', {}).get('simpleText') or \
                    (video.get('title', {}).get('runs', [{}])[0].get('text') if video.get('title', {}).get('runs') else '')

            thumbnail = ''
            thumbs = video.get('thumbnail', {}).get('thumbnails', [])
            if thumbs:
                thumbnail = thumbs[0].get('url', '')

            # Upcoming
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
                    continue

            # LIVE - indépendant
            badges = video.get('badges', [])
            is_live = any(
                badge.get('liveBadgeRenderer') or badge.get('style') == 'LIVE'
                for badge in badges if isinstance(badge, dict)
            )

            if is_live:
                view_text = video.get('viewCountText', {})
                viewer_str = view_text.get('simpleText') or \
                             (view_text.get('runs', [{}])[0].get('text') if view_text.get('runs') else '')
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

        return results

    except Exception as e:
        log_message(f"Erreur extract_from_ytinitialdata: {e}")
        return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True)
    args = parser.parse_args()
    access_token = args.access_token

    if not validate_access_token(access_token):
        log_message("Token invalide, arrêt")
        sys.exit(1)

    start_time = time.time()
    try:
        channels = list(youtube_channels_collection.find({}))
        log_message(f"{len(channels)} chaînes chargées")

        video_results = []
        with requests.Session() as session:
            with ThreadPoolExecutor(max_workers=8) as executor:   # légèrement réduit
                futures = {executor.submit(process_url, ch, session, access_token): ch for ch in channels}
                for future in as_completed(futures):
                    video_results.extend(future.result())

        if video_results:
            youtube_videos_collection.delete_many({})
            youtube_videos_collection.insert_many(video_results)
            log_message(f"{len(video_results)} vidéos insérées")

        upcoming = sum(1 for v in video_results if v.get("status") == "upcoming")
        live = sum(1 for v in video_results if v.get("status") == "live")
        log_message(f"TOTAL : {len(video_results)} vidéos (upcoming: {upcoming}, live: {live})")
        log_message(f"Temps : {time.time() - start_time:.2f}s")

    except Exception as e:
        log_message(f"Erreur générale : {e}")

if __name__ == '__main__':
    main()
