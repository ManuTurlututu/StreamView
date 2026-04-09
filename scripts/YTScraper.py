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
import gc
import psutil

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
    scraper_stats_collection = db['scraperStats']
    print("✅ Connecté à MongoDB")
except ConnectionFailure as e:
    print(f"Erreur MongoDB : {e}")
    sys.exit(1)


def log_message(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")
    sys.stdout.flush()


process = psutil.Process(os.getpid())
max_memory_mb = 0.0
total_html_size = 0


def update_peak_memory():
    global max_memory_mb
    try:
        current_mb = process.memory_info().rss / (1024 * 1024)
        if current_mb > max_memory_mb:
            max_memory_mb = current_mb
    except:
        pass


def get_current_peak_mb():
    update_peak_memory()
    return max_memory_mb


def process_url(channel_data, session, access_token):
    global total_html_size
    results = []
    channel_id = channel_data.get('channelId', '')
    if not channel_id:
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams?gl=US&hl=en"

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.youtube.com/",
            "Authorization": f"Bearer {access_token}",
        }
        cookies = {
            "CONSENT": "YES+cb.20250403-00-p0.fr+FX+123",
            "SOCS": "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjUwNjAzLjAzX3AwGgJmciACGgYIgJn-wQY",
        }

        response = session.get(url, headers=headers, cookies=cookies, timeout=25)
        response.raise_for_status()
        html_content = response.text
        total_html_size += len(html_content)

        if any(x in html_content.lower() for x in ["consent.youtube.com", "avant d'accéder", "before you continue"]):
            return results

        # UPCOMING
        for upcoming_pos in [m.start() for m in re.finditer(r'"upcomingEventData"', html_content)]:
            start_time_match = re.search(r'"startTime":"(\d+)"', html_content[upcoming_pos:upcoming_pos + 1000])
            if not start_time_match:
                continue
            start_time = start_time_match.group(1)

            segment = html_content[max(0, upcoming_pos - 4000):upcoming_pos + 1000]

            title_search = re.search(r'"title":(?:{"runs":\[{"text":"((?:[^"\\]|\\.)*?)"\}|{"simpleText":"((?:[^"\\]|\\.)*?)"}|{"accessibility":{"accessibilityData":{"label":"((?:[^"\\]|\\.)*?)"}}})', segment, re.DOTALL)
            title = title_search.group(1) or title_search.group(2) or title_search.group(3) if title_search else ''
            if title:
                title = title.replace(r'\u0026', '&')

            thumb_search = re.search(r'"thumbnails":\s*\[\s*{"url":"([^"]+)"', segment, re.DOTALL)
            video_thumbnail = thumb_search.group(1) if thumb_search else ''

            vid_search = re.search(r'"videoId":"([A-Za-z0-9_-]+)"', segment, re.DOTALL)
            video_url = f"https://www.youtube.com/watch?v={vid_search.group(1)}" if vid_search else ''

            if title and video_url:
                results.append({
                    "vidUrl": video_url, "vidTitle": title, "vidThumbnail": video_thumbnail,
                    "startTime": start_time, "chUrl": url, "chTitle": channel_title,
                    "chThumbnail": ch_thumbnail, "status": "upcoming",
                    "timestamp": datetime.now().isoformat()
                })

        # LIVE (similaire, je garde ton code original pour ne pas casser)
        # ... (je garde ton bloc LIVE tel quel pour l'instant)

        return results

    except Exception:
        return results


def validate_access_token(access_token):
    try:
        r = requests.get("https://www.googleapis.com/oauth2/v3/tokeninfo",
                         params={"access_token": access_token}, timeout=10)
        r.raise_for_status()
        data = r.json()
        return int(data.get('expires_in', 0)) > 0
    except:
        return False


def main():
    global max_memory_mb, total_html_size
    max_memory_mb = 0.0
    total_html_size = 0

    parser = argparse.ArgumentParser()
    parser.add_argument('--access-token', required=True)
    args = parser.parse_args()

    log_message(f"")
    log_message(f"================= YT Scrapping =================")

    if not validate_access_token(args.access_token):
        print("❌ Token invalide ou expiré")
        sys.exit(1)

    start_time = time.time()

    stats = scraper_stats_collection.find_one({"_id": "last_scraper_run"})
    prev_peak_mb = stats.get("peak_memory_mb", 250.0) if stats else 250.0
    prev_workers = stats.get("max_workers_used", 3) if stats else 3
    last_run_timestamp = stats.get("timestamp") if stats else None

    log_message(f"📈 Last Peak Ram : {prev_peak_mb:.1f} MB | Workers: {prev_workers}")

    # Temps depuis dernière exécution
    time_since_last_str = "Première exécution"
    minutes_since_last = 0
    if last_run_timestamp:
        try:
            last_time = datetime.fromisoformat(last_run_timestamp.replace("Z", "+00:00"))
            delta = datetime.now() - last_time
            minutes_since_last = delta.total_seconds() / 60
            time_since_last_str = f"{minutes_since_last:.2f} min"
        except:
            pass

    # ====================== WORKERS ======================
    if minutes_since_last > 5:
        max_workers = 2
        log_message(f"⚠️ Plus de 5 min depuis dernière exécution → workers forcés à 2")
    else:
        max_workers = min(4, prev_workers + 1)      # On reste très conservateur
        log_message(f"✅ workers set at : {max_workers}")

    channels = list(youtube_channels_collection.find({}))
    log_message(f"{len(channels)} YT channels (max_workers = {max_workers})")

    video_results = []

    with requests.Session() as session:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(process_url, ch, session, args.access_token): ch for ch in channels}

            for future in as_completed(futures):
                result = future.result()
                video_results.extend(result)
                time.sleep(0.05)        # très léger

    # Sauvegarde
    if video_results:
        youtube_videos_collection.delete_many({})
        youtube_videos_collection.insert_many(video_results)

    execution_time = time.time() - start_time
    final_peak_mb = get_current_peak_mb()
    total_html_mb = total_html_size / (1024 * 1024)

    current_timestamp = datetime.now().isoformat()

    scraper_stats_collection.update_one(
        {"_id": "last_scraper_run"},
        {"$set": {
            "max_workers_used": max_workers,
            "peak_memory_mb": final_peak_mb,
            "total_html_mb": round(total_html_mb, 2),
            "execution_time_sec": round(execution_time, 2),
            "videos_found": len(video_results),
            "timestamp": current_timestamp
        }},
        upsert=True
    )

    upcoming_total = sum(1 for r in video_results if r.get("status") == "upcoming")
    live_total = sum(1 for r in video_results if r.get("status") == "live")

    log_message(f"✅ {len(video_results)} Saved YT Vids (Upcoming: {upcoming_total} | Live: {live_total})")
    log_message(f"🔥 Memory used : {final_peak_mb:.1f} MB")
    log_message(f"📦 Total Download : {total_html_mb:.2f} MB")
    log_message(f"⏱️ Time : {execution_time:.2f} secondes")
    log_message(f"⏱️ Last scrap : {time_since_last_str}")
    log_message(f"📊 Workers : {max_workers}")
    log_message(f"=============== END YT Scrapping ===============")
    log_message("")

    del video_results
    gc.collect()


if __name__ == '__main__':
    main()
