from pymongo import UpdateOne
import sys
import requests
import os
import re
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
import argparse
from dotenv import load_dotenv
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure
import gc
import psutil
import random

# Forcer l'encodage UTF-8
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
    scraper_config_collection = db['scraperConfig']
except ConnectionFailure as e:
    print(f"YTSCRAPPER Erreur MongoDB : {e}")
    sys.exit(1)


def log_message(message):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}")
    sys.stdout.flush()

# ====================== INIT COOKIES (first run only) ======================
if not scraper_config_collection.find_one({"_id": "yt_cookies"}):
    scraper_config_collection.insert_one({
        "_id": "yt_cookies",
        "CONSENT": "YES+cb.20250509-00-p0.fr+FX+123",  # ← valeur initiale
        "SOCS": "CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjUwNjAzLjAzX3AwGgJmciACGgYIgJn-wQY",
        "updatedAt": datetime.now(timezone.utc).isoformat()
    })
    log_message("🍪 Collection scraperConfig initialisée avec cookies par défaut")

# ====================== SUIVI MÉMOIRE ======================
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


def process_url(channel_data, session, access_token, yt_cookies):
    global total_html_size
    results = []
    channel_id = channel_data.get('channelId', '')
    channel_title = channel_data.get('title', 'Unknown')
    ch_thumbnail = channel_data.get('thumbnail', '')

    if not channel_id:
        return results

    url = f"https://www.youtube.com/channel/{channel_id}/streams?gl=US&hl=en"

    USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    ]

    for attempt in range(2):
        try:
            headers = {
                "User-Agent": random.choice(USER_AGENTS),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://www.youtube.com/",
                "Authorization": f"Bearer {access_token}",
            }

            cookies = yt_cookies

            response = session.get(url, headers=headers, cookies=cookies, timeout=40)
            response.raise_for_status()
            html_content = response.text
            total_html_size += len(html_content)

            # ====================== Debug Html Save ======================

            DEBUG_CHANNEL = "Namie"  # Nom partiel de la chaine cible, vide = première chaine
            if not getattr(process_url, '_debug_saved', False):
                if not DEBUG_CHANNEL or DEBUG_CHANNEL.lower() in channel_title.lower():
                    process_url._debug_saved = True
                    import pathlib
                    debug_dir = pathlib.Path(__file__).parent / "debug"
                    debug_dir.mkdir(exist_ok=True)
                    with open(debug_dir / "yt_last_page.html", "w", encoding="utf-8") as f:
                        f.write(html_content)

            # ==============================================================

            if len(html_content) < 50000:
                log_message(f"⚠️ Suspicious page {channel_title} ({len(html_content)} bytes)")
                return results

            triggers = [x for x in ["consent.youtube.com", "avant d'accéder", "before you continue"] if x in html_content.lower()]
            if triggers:
                log_message(f"⚠️ Consent page detected {channel_title} | trigger: {triggers}")
                return results

            # ==================== SCRAPPING : UPCOMING & LIVE  ====================

            def parse_scheduled_date(text):
                text = text.replace('\u202f', ' ').strip()
                m = re.search(r'(\d{1,2}/\d{1,2}/\d{2,4}),?\s*(\d{1,2}:\d{2}\s*[AP]M)', text, re.IGNORECASE)
                if not m:
                    log_message(f"❌ StartTime noMatch: {repr(text)}")
                    return '946684800'
                try:
                    from zoneinfo import ZoneInfo
                    dt = datetime.strptime(f'{m.group(1)} {m.group(2).strip()}', '%m/%d/%y %I:%M %p')
                    dt = dt.replace(tzinfo=ZoneInfo('America/New_York'))
                    return str(int(dt.timestamp()))
                except Exception as e:
                    log_message(f"❌ StartTime parse error: {repr(text)} → {e}")
                    return '946684800'

            for item_match in re.finditer(r'\{"richItemRenderer":\{"content":', html_content):
                block = html_content[item_match.start():item_match.start() + 12000]

                badge_search = re.search(r'"text":"(Upcoming|LIVE)"', block)
                if not badge_search:
                    continue
                badge = badge_search.group(1)

                vid_search = re.search(r'ytimg\.com/vi/([A-Za-z0-9_-]+)/', block)
                if not vid_search:
                    continue
                video_id = vid_search.group(1)
                video_url = f"https://www.youtube.com/watch?v={video_id}"
                video_thumbnail = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"

                title_search = re.search(r'lockupMetadataViewModel.*?"title":\{"content":"((?:[^"\\]|\\.)*?)"', block, re.DOTALL)
                title = title_search.group(1).replace(r'\u0026', '&') if title_search else ''

                if not title or not video_url:
                    continue

                if badge == 'Upcoming':
                    sched_search = re.search(r'Scheduled for ([^"\\]+)', block)
                    start_time = parse_scheduled_date(sched_search.group(1)) if sched_search else str(int(time.time()))
                    results.append({
                        "vidUrl": video_url, "vidTitle": title, "vidThumbnail": video_thumbnail,
                        "startTime": start_time, "chUrl": url, "chTitle": channel_title,
                        "chThumbnail": ch_thumbnail, "status": "upcoming",
                        "timestamp": datetime.now().isoformat()
                    })

                elif badge == 'LIVE':
                    viewers_search = re.search(r'"content":"([\d,.]+K?)\s*watching"', block)
                    if viewers_search:
                        v = viewers_search.group(1).replace(',', '')
                        viewer_count = int(float(v.replace('K', '')) * 1000) if 'K' in v else int(v)
                    else:
                        viewer_count = 0
                    results.append({
                        "vidUrl": video_url, "vidTitle": title, "vidThumbnail": video_thumbnail,
                        "startTime": str(int(time.time())), "chUrl": url, "chTitle": channel_title,
                        "chThumbnail": ch_thumbnail, "status": "live",
                        "viewer_count": viewer_count, "timestamp": datetime.now().isoformat()
                    })

            return results

        except requests.exceptions.Timeout:
            log_message(f"⏱️ Timeout {channel_title} (tentative {attempt + 1}/2)")
            if attempt < 1:
                time.sleep(2)
                continue
            return results

        except Exception as e:
            log_message(f"❌ Error {channel_title}: {type(e).__name__}: {e}")
            return results

    return results


def validate_access_token(access_token):
    try:
        r = requests.get("https://www.googleapis.com/oauth2/v3/tokeninfo",
                         params={"access_token": access_token}, timeout=10)
        r.raise_for_status()
        data = r.json()
        return int(data.get('expires_in', 0)) > 0
    except Exception:
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

    # ====================== CHARGEMENT STATS PRÉCÉDENTES ======================
    stats = scraper_stats_collection.find_one({"_id": "last_scraper_run"})
    
    prev_peak_mb = stats.get("peak_memory_mb", 250.0) if stats else 250.0
    prev_workers = stats.get("max_workers_used", 3) if stats else 3
    prev_execution_time = stats.get("execution_time_sec", 0) if stats else 0

    log_message(f"📈 Last Peak Ram : {prev_peak_mb:.1f} MB | Workers: {prev_workers}")

    # ====================== DÉTERMINATION DU NOMBRE DE WORKERS ======================
    minutes_since_last = 0
    if stats and stats.get("timestamp"):
        try:
            prev_end_str = stats["timestamp"]
            if prev_end_str.endswith('Z'):
                prev_end_str = prev_end_str.replace('Z', '+00:00')
            prev_end_time = datetime.fromisoformat(prev_end_str)
            if prev_end_time.tzinfo is None:
                prev_end_time = prev_end_time.replace(tzinfo=timezone.utc)
            else:
                prev_end_time = prev_end_time.astimezone(timezone.utc)

            delta = datetime.now(timezone.utc) - prev_end_time
            minutes_since_last = delta.total_seconds() / 60
        except:
            minutes_since_last = 0

    if minutes_since_last > 8:
        max_workers = 1
        log_message(f"⚠️ Plus de 8 min depuis dernier run → workers forcés à 1")
    else:
        max_workers = min(2, prev_workers + 1)
        log_message(f"✅ workers set at : {max_workers}")
        

# ====================== CHARGEMENT COOKIES YT ======================
    yt_cookies_doc = scraper_config_collection.find_one({"_id": "yt_cookies"})
    if yt_cookies_doc:
        yt_cookies = {k: v for k, v in yt_cookies_doc.items() if k not in ("_id", "updatedAt")}
        log_message(f"🍪 Cookies YT chargés depuis DB (màj: {yt_cookies_doc.get('updatedAt', '?')})")
    else:
        yt_cookies = {}
        log_message(f"⚠️ Aucun cookie YT en DB, requêtes sans cookies")

    # ====================== SCRAPING ======================
    channels = list(youtube_channels_collection.find({}))
    log_message(f"📡 {len(channels)} YT Channels Loaded (max_workers = {max_workers})")

    video_results = []
    with requests.Session() as session:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(process_url, ch, session, args.access_token, yt_cookies): ch for ch in channels}
            for future in as_completed(futures):
                result = future.result()
                video_results.extend(result)
                time.sleep(random.uniform(0.07, 0.1))

    if len(video_results) < 2:
        log_message(f"❌ Scrapping Failed ({len(video_results)} vids results), DB not updated (anti-flush)")
        scraper_stats_collection.update_one(
            {"_id": "last_scraper_run"},
            {"$set": {"last_fail_timestamp": datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}},
            upsert=True
        )
        log_message(f"=============== END YT Scrapping ===============")
        log_message("")
        return

    # ====================== GESTION INTELLIGENTE DES STATUTS (LIVE → VOD) ======================
    log_message("🔄 Mise à jour des statuts Live → VOD...")

    # Récupérer tous les anciens lives
    old_lives = list(youtube_videos_collection.find({"status": "live"}))

    current_live_urls = {video["vidUrl"] for video in video_results if video.get("status") == "live"}

    updates = []
    converted_to_vod = 0

    for old in old_lives:
        if old["vidUrl"] not in current_live_urls:
            # Cette vidéo n'est plus en live → on la passe en VOD
            updates.append(
                UpdateOne(
                    {"vidUrl": old["vidUrl"]},
                    {"$set": {
                        "status": "vod",
                        "endedAt": datetime.now(timezone.utc).isoformat(),
                        "timestamp": datetime.now().isoformat()
                    }}
                )
            )
            converted_to_vod += 1

    if updates:
        youtube_videos_collection.bulk_write(updates)
        log_message(f"✅ {converted_to_vod} live(s) terminé(s) → passés en statut 'vod'")

    # ====================== SAUVEGARDE DES RÉSULTATS (Live + Upcoming) ======================

    operations = []
    
    for video in video_results:
        vid_url = video.get("vidUrl")
        if not vid_url:
            continue

        if video.get("status") == "live":
            # Pour les lives : on préserve le startTime d'origine
            set_data = {k: v for k, v in video.items() if k != "startTime"}
            operations.append(
                UpdateOne(
                    filter={"vidUrl": vid_url},
                    update={
                        "$set": set_data,
                        "$setOnInsert": {
                            "startTime": str(int(time.time())),
                            "firstDetectedAt": datetime.now(timezone.utc).isoformat()
                        }
                    },
                    upsert=True
                )
            )
        else:
            # Upcoming ou futures VOD (déjà gérées plus haut)
            operations.append(
                UpdateOne(
                    filter={"vidUrl": vid_url},
                    update={"$set": video},
                    upsert=True
                )
            )

    if operations:
        result = youtube_videos_collection.bulk_write(operations)
        log_message(f"✅ {len(video_results)} vidéos traitées "
                    f"({result.upserted_count} créées | {result.modified_count} mises à jour)")

    # ====================== SAUVEGARDE DES STATS FINALES ======================
    execution_time = time.time() - start_time
    final_peak_mb = get_current_peak_mb()
    total_html_mb = total_html_size / (1024 * 1024)
    current_timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

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
    vod_converted_this_run = converted_to_vod

# Last Scrap fail format

    last_fail_str = stats.get("last_fail_timestamp") if stats else None
    if last_fail_str:
        try:
            last_fail_dt = datetime.fromisoformat(last_fail_str.replace('Z', '+00:00'))
            last_fail_local = last_fail_dt.strftime('%d/%m/%y %H:%M UTC')
            delta_fail = datetime.now(timezone.utc) - last_fail_dt
            total_seconds = int(delta_fail.total_seconds())
            if total_seconds < 3600:
                ago_str = f"{total_seconds // 60}min ago"
            elif total_seconds < 86400:
                ago_str = f"{total_seconds // 3600}h ago"
            else:
                ago_str = f"{total_seconds // 86400}d ago"
            last_fail_display = f"{last_fail_local} ({ago_str})"
        except:
            last_fail_display = last_fail_str
    else:
        last_fail_display = None

# ====================== LOGS FINAUX ======================
    log_message(f"✅ {len(video_results)} YT Vids Saved "
               f"(Upcoming: {upcoming_total} | Live: {live_total} | VOD converted: {vod_converted_this_run})")
    log_message(f"🔥 Peak Ram : {final_peak_mb:.1f} MB")
    log_message(f"📦 Total Download : {total_html_mb:.2f} MB")
    log_message(f"⏱️ Scrap Time : {execution_time:.2f} s")
    log_message(f"📊 Workers : {max_workers}")
    if last_fail_display:
        log_message(f"⚠️ Last Scrap Failed : {last_fail_display}")
    log_message(f"=============== END YT Scrapping ===============")
    log_message("")

    # Nettoyage mémoire
    del video_results
    gc.collect()


if __name__ == '__main__':
    main()
