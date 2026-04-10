require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const path = require("path");
const { exec } = require("child_process");
const cron = require("node-cron");
const util = require("util");
const rateLimit = require("express-rate-limit");
const execPromise = util.promisify(exec);
const { EventEmitter } = require('events');
const mongoose = require('mongoose');

const notificationEmitter = new EventEmitter();
const app = express();
const cors = require('cors');

// ==================== DÉTECTION MODE (Local vs Serveur) ====================
const isLocal = process.env.NODE_ENV !== 'production' || process.env.IS_LOCAL === 'true';
const APP_URL = process.env.APP_URL || (isLocal ? 'https://streamview0.loca.lt' : 'https://your-app.onrender.com');
console.log(`[${new Date().toISOString()}] ================ 🚀 SERVEUR LAUNCH ================`);
console.log(`[${new Date().toISOString()}] 🚀 SERVEUR LAUNCH → ${isLocal ? 'LOCAL (Vite + loca.lt)' : 'RENDER (Online)'}`);

// ==================== CONFIGURATION SCRAPER SELON MODE ====================
let lastScrapDurationSeconds = isLocal 
  ? 40          // Local → scrape rapide pour le dev
  : 600;        // Production (Render) → toutes les 10 minutes

console.log(`[${new Date().toISOString()}] ⏱️ Initial Scrap Duration : ${lastScrapDurationSeconds}s → ${isLocal ? 'LOCAL (Vite + loca.lt)' : 'RENDER (Online)'}`);
console.log(`[${new Date().toISOString()}] ================ 🚀 SERVEUR LAUNCH ================\n`);

// Middleware
app.use(cors({
  origin: isLocal ? 'https://streamview0.loca.lt' : true,   // true = tout autoriser en prod
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.static("public"));
app.use(cookieParser());
app.use(express.json());

// Configuration
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_REDIRECT_URI;

const youtubeClientId = process.env.YOUTUBE_CLIENT_ID;
const youtubeClientSecret = process.env.YOUTUBE_CLIENT_SECRET;
const youtubeRedirectUri = process.env.YOUTUBE_REDIRECT_URI;
const youtubeScope = "https://www.googleapis.com/auth/youtube.readonly";

// Variables globales
let youtubeAccessToken = null;
let youtubeRefreshToken = null;
let twitchAccessToken = null;
let twitchRefreshToken = null;
let twitchUserId = null;

// Variables pour cron dynamique
let currentYoutubeCron = null;

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log(`[${new Date().toISOString()}]✅ Connected (MongoDB)`))
.catch(error => console.error(`[${new Date().toISOString()}]❌ Erreur de connexion à MongoDB:`, error.message));

// Schéma pour les paramètres des cloches de notification
const channelsBellsSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  platform: { type: String, required: true, enum: ['twitch', 'youtube'] },
  channelId: { type: String, required: true },
  notificationsEnabled: { type: Boolean, required: true, default: false },
}, { collection: 'ChannelsBells', timestamps: true });

const ChannelsBells = mongoose.model('ChannelsBells', channelsBellsSchema);

// Schéma pour les notifications
const notificationSchema = new mongoose.Schema({
  id: { type: String, required: true },
  user_id: { type: String, required: true },
  user_name: { type: String, required: true },
  title: { type: String, required: true },
  avatar_url: { type: String, required: true },
  timestamp: { type: Number, required: true }
}, { timestamps: true });

const Notification = mongoose.model('Notification', notificationSchema);

// Schéma pour les chaînes YouTube
const youtubeChannelSchema = new mongoose.Schema({
  channelId: { type: String, required: true, unique: true },
  customUrl: String,
  title: String,
  thumbnail: String,
  bannerExternalUrl: String,
  subscriptionDate: Date,
  publishedAt: Date,
  subscriberCount: String,
  viewCount: String,
  country: String
});

const YoutubeChannel = mongoose.model('YoutubeChannel', youtubeChannelSchema);

// Schéma pour les tokens API
const tokenApiSchema = new mongoose.Schema({
  platform: { type: String, required: true, unique: true },
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
  userId: { type: String }, // Ajout pour Twitch
  expiresIn: { type: Number, required: true },
  lastUpdated: { type: Date, default: Date.now }
});

const TokenApi = mongoose.model('TokenApi', tokenApiSchema);

// Schéma pour les vidéos YouTube
const youtubeVideoSchema = new mongoose.Schema({
  vidUrl: { type: String, required: true },
  vidTitle: { type: String, required: true },
  vidThumbnail: { type: String, required: true },
  startTime: { type: String, required: true }, // Note : startTime est une chaîne, pas un nombre
  chUrl: { type: String, required: true },
  chTitle: { type: String, required: true },
  chThumbnail: { type: String, required: true },
  status: { type: String, required: true },
  viewer_count:{ type: Number, default: 0 },
  timestamp: { type: String, required: true }
}, { collection: 'youtubeVideos' }); // Forcer le nom de la collection

const YoutubeVideo = mongoose.model('YoutubeVideo', youtubeVideoSchema);

// Schéma pour la collection Live (Twitch et YouTube)
const liveSchema = new mongoose.Schema({
  platform: { type: String, required: true, enum: ['twitch', 'youtube'] }, // Plateforme : twitch ou youtube
  user_id: { type: String, required: true }, // ID unique (user_id pour Twitch, _id pour YouTube)
  user_name: { type: String, required: true }, // Nom de la chaîne (user_name pour Twitch, chTitle pour YouTube)
  title: { type: String, required: true }, // Titre du stream (title pour Twitch, vidTitle pour YouTube)
  thumbnail_url: { type: String, required: true }, // URL de la miniature (thumbnail_url pour Twitch, vidThumbnail pour YouTube)
  avatar_url: { type: String, required: true }, // URL de l'avatar (profile_image_url pour Twitch, chThumbnail pour YouTube)
  viewer_count: { type: Number, default: 0 }, // Nombre de spectateurs (viewer_count pour Twitch, 0 pour YouTube)
  started_at: { type: Number, required: true }, // Timestamp de début (timestamp de started_at pour Twitch, startTime pour YouTube)
  game_name: { type: String, default: "Inconnu" }, // Nom du jeu (game_name pour Twitch, "Inconnu" pour YouTube)
  stream_url: { type: String, required: true }, // URL du stream (twitch.tv/user_name pour Twitch, vidUrl pour YouTube)
  timestamp: { type: Number, required: true } // Timestamp de la mise à jour
}, { collection: 'liveStreams', timestamps: true });

const Live = mongoose.model('Live', liveSchema);

// Sauvegarder les streams dans la collection Live
async function saveLiveStreams(streams) {
  try {
    const operations = streams.map(stream => ({
      updateOne: {
        filter: { platform: stream.platform, user_id: stream.user_id },
        update: { $set: stream },
        upsert: true
      }
    }));
    await Live.bulkWrite(operations);
    console.log(`[${new Date().toISOString()}]🔴 Twitch Live (TW_API) : ${streams.length}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Live Streams Save Error :`, error.message);
  }
}

// Charger les notifications depuis MongoDB (uniquement les 7 derniers jours)
async function loadNotificationLog() {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const notifications = await Notification.find({ timestamp: { $gt: sevenDaysAgo } }).sort({ timestamp: -1 });
    return notifications;
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la lecture des notifications depuis MongoDB:`, error.message);
    return [];
  }
}

// Sauvegarder une notification dans MongoDB
async function saveNotificationLog(notification) {
  try {
    const newNotification = new Notification(notification);
    await newNotification.save();
    console.log(`[${new Date().toISOString()}]💾 Notification Saved (MongoDB) : ${notification.user_name}(${notification.platform})`); 
  
    notificationEmitter.emit("new-notification", notification);
    console.log(`[${new Date().toISOString()}]📡 SSE Notification sent : ${notification.user_name}(${notification.platform})`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la sauvegarde de la notification dans MongoDB:`, error.message);
  }
}

// Charger les chaînes YouTube depuis MongoDB
async function loadYoutubeChannels() {
  try {
    const channels = await YoutubeChannel.find({});
    return channels;
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la lecture des chaînes YouTube depuis MongoDB:`, error.message);
    return [];
  }
}

// Sauvegarder les chaînes YouTube dans MongoDB avec upsert
async function saveYoutubeChannels(channels) {
  try {
    const operations = channels.map(channel => ({
      updateOne: {
        filter: { channelId: channel.channelId },
        update: { $set: channel },
        upsert: true
      }
    }));
    await YoutubeChannel.bulkWrite(operations);
    console.log(`[${new Date().toISOString()}]💾 YouTube Channels Saved (MongoDB) : ${channels.length} chaînes`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la sauvegarde des chaînes YouTube dans MongoDB:`, error.message);
  }
}

// Synchroniser les vidéos live YouTube
async function syncYoutubeLiveVideos() {
  try {
    const liveVideos = await YoutubeVideo.find({ status: 'live' });    

    const existingStreams = await Live.find({ platform: 'youtube' });
    const existingStreamIds = new Set(existingStreams.map(stream => stream.user_id));

    // ====================== AJUSTEMENT SELON INTERVALLE CRON ======================
    // Tu peux changer cette valeur facilement ici
    const scraperIntervalMinutes = 10;                    // ← Change ici selon ton cron (ex: 8, 10, 12...)
    const adjustmentMs = (scraperIntervalMinutes / 2) * 60 * 1000;   // moitié de l'intervalle en ms

    const formattedVideos = liveVideos.map(video => {
      let started_at;

      if (video.startTime) {
        const ts = Number(video.startTime);

        if (!isNaN(ts)) {
          if (ts > 1000000000 && ts < 2000000000) {        // timestamp en secondes
            let detectedTime = ts * 1000;                   // conversion en millisecondes

            // Ajustement : on enlève la moitié de l'intervalle du scraper
            started_at = detectedTime - adjustmentMs;

            // Sécurité : ne pas aller dans le futur ou trop loin dans le passé
            if (started_at > Date.now()) {
              started_at = Date.now() - (5 * 60 * 1000);    // max 5 min dans le passé
            }
          } else if (ts > 1000000000000) {
            started_at = ts - adjustmentMs;
          } else {
            started_at = Date.now();
          }
        } else {
          started_at = Date.now();
        }
      } else {
        started_at = Date.now();
      }

      return {
        platform: 'youtube',
        user_id: video.chUrl.split('/channel/')[1] || video.chTitle || 'unknown',
        user_name: video.chTitle || 'Inconnu',
        title: video.vidTitle || 'Aucun titre',
        thumbnail_url: video.vidThumbnail || 'https://i.ytimg.com/img/no_thumbnail.jpg',
        avatar_url: video.chThumbnail || 'https://yt3.ggpht.com/ytc/default-channel-img.jpg',
        viewer_count: video.viewer_count || 0,
        started_at: started_at,
        game_name: 'Inconnu',
        stream_url: video.vidUrl,
        timestamp: Date.now()
      };
    });

    // Détecter les nouveaux streams
    const newStreams = formattedVideos.filter(video => !existingStreamIds.has(video.user_id));
    if (newStreams.length > 0) {
      console.log(`[${new Date().toISOString()}]🔴 New YT Live(${newStreams.length}) : `, newStreams.map(s => s.user_name));
    }

    // Notifications pour nouveaux lives
    for (const video of newStreams) {
      const notification = {
        id: `youtube-${video.user_id}-${Date.now()}`,
        user_id: video.user_id,
        user_name: video.user_name,
        title: video.title,
        avatar_url: video.avatar_url,
        platform: 'youtube',
        vidUrl: video.stream_url,
        timestamp: Date.now()
      };
      await saveNotificationLog(notification);
    }

    // Sauvegarde dans liveStreams
    if (formattedVideos.length > 0) {
      const operations = formattedVideos.map(video => ({
        updateOne: {
          filter: { platform: 'youtube', user_id: video.user_id },
          update: { $set: video },
          upsert: true
        }
      }));
      await Live.bulkWrite(operations);
      console.log(`[${new Date().toISOString()}]✅ YT Live Updated (MongoDB) : ${liveVideos.length}`);
    }

    // Nettoyage des lives terminés
    await Live.deleteMany({ 
      platform: 'youtube', 
      user_id: { $nin: formattedVideos.map(video => video.user_id) } 
    });
    console.log(`[${new Date().toISOString()}]✅ Ended YT Live removed`);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] ❌ Erreur sync YouTube Live:`, error.message);
  }
}

async function syncTwitchLiveStreams() {
  try {
    if (!twitchAccessToken || !twitchUserId) {
      console.log(`[${new Date().toISOString()}]❌ Twitch Token or userId Twitch missing, Refreshing...`);
      if (!twitchRefreshToken) {
        throw new Error("❌ Twitch Token Missing");
      }
      const { accessToken: newAccessToken } = await refreshAccessToken(twitchRefreshToken);
      twitchAccessToken = newAccessToken;
      await saveTwitchTokens();
    }

    const followedStreams = await getFollowedStreams(twitchAccessToken);    

    // Récupérer les profils des utilisateurs pour obtenir profile_image_url
    const userIds = followedStreams.data?.map(stream => stream.user_id) || [];
    let profiles = {};
    if (userIds.length > 0) {
      // Diviser les userIds en lots de 100
      const batches = [];
      for (let i = 0; i < userIds.length; i += 100) {
        batches.push(userIds.slice(i, i + 100));
      }

      // Effectuer une requête pour chaque lot
      for (const batch of batches) {
          try {
            const userResponse = await axios.get(`https://api.twitch.tv/helix/users?${batch.map(id => `id=${id}`).join('&')}`, {
              headers: {
                "Client-ID": process.env.TWITCH_CLIENT_ID,
                Authorization: `Bearer ${twitchAccessToken}`,
              },
            });
       // Ajouter un délai de 1 seconde entre les lots pour respecter les limites de taux
       await new Promise(resolve => setTimeout(resolve, 1000));
          userResponse.data.data.forEach(user => {
            profiles[user.id] = user.profile_image_url || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png';
          });
        } catch (error) {
          console.error(`[${new Date().toISOString()}] ❌ Twitch profile Load Error batch :`, batch, error.message);
          if (error.response) {
            console.error(`[${new Date().toISOString()}] ❌ API Error:`, error.response.status, error.response.data);
          }
          // Attribuer une image par défaut pour les utilisateurs du lot en cas d'erreur
          batch.forEach(id => {
            profiles[id] = 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png';
          });
        }
      }      
    }

    // Récupérer l'état actuel de liveStreams pour Twitch
    const existingStreams = await Live.find({ platform: 'twitch' });
    const existingStreamIds = new Set(existingStreams.map(stream => stream.user_id));

    const formattedStreams = followedStreams.data?.map(stream => ({
      platform: 'twitch',
      user_id: stream.user_id,
      user_name: stream.user_name || 'Inconnu',
      title: stream.title || 'Aucun titre',
      thumbnail_url: stream.thumbnail_url || 'https://static-cdn.jtvnw.net/ttv-static/404_preview.jpg',
      avatar_url: profiles[stream.user_id] || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png',
      viewer_count: stream.viewer_count || 0,
      started_at: new Date(stream.started_at).getTime(),
      game_name: stream.game_name || 'Inconnu',
      stream_url: `https://www.twitch.tv/${stream.user_name.toLowerCase()}`,
      timestamp: Date.now()
    })) || [];

    // Détecter les nouveaux streams
    const newStreams = formattedStreams.filter(stream => !existingStreamIds.has(stream.user_id));
    if (newStreams.length > 0) {
        console.log(`[${new Date().toISOString()}]🔴 New Twitch Live(${newStreams.length}) : `, newStreams.map(s => s.user_name));
    }

    // Enregistrer une notification pour chaque nouveau stream
    for (const stream of newStreams) {
      const notification = {
        id: `twitch-${stream.user_id}-${Date.now()}`,
        user_id: stream.user_id,
        user_name: stream.user_name,
        title: stream.title,
        avatar_url: stream.avatar_url,
        platform: 'twitch',
        timestamp: Date.now()
      };
      await saveNotificationLog(notification);
    }

    if (formattedStreams.length > 0) {
      await saveLiveStreams(formattedStreams);
    } else {
      console.log(`[${new Date().toISOString()}] Aucun stream Twitch en direct à sauvegarder`);
    }

    await Live.deleteMany({
      platform: 'twitch',
      user_id: { $nin: formattedStreams.map(stream => stream.user_id) }
    });
    console.log(`[${new Date().toISOString()}]✅ Ended TW live Removed`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la synchronisation:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur API:`, error.response.status, error.response.data);
    }
  }
}

async function getFollowedStreams(accessToken, cursor = null, retryCount = 0) {
  if (!twitchUserId) {
    throw new Error("❌ Aucun ID utilisateur Twitch disponible");
  }
  const maxRetries = 1; // Limite à une tentative de rafraîchissement
  let allStreams = [];
  let nextCursor = cursor;

  do {
    const params = { user_id: twitchUserId, first: 100 };
    if (nextCursor) params.after = nextCursor;

    try {
      const response = await axios.get("https://api.twitch.tv/helix/streams/followed", {
        headers: {
          "Client-ID": process.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`,
        },
        params,
      });
      allStreams = allStreams.concat(response.data.data || []);
      nextCursor = response.data.pagination?.cursor || null;
    } catch (error) {
      console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des streams Twitch:`, error.message);
      if (error.response) {
        console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur API:`, error.response.status, error.response.data);
        // Gérer l'erreur 401 (jeton expiré)
        if (error.response.status === 401 && twitchRefreshToken && retryCount < maxRetries) {
          console.log(`[${new Date().toISOString()}]❌ Erreur 401 détectée, tentative de rafraîchissement du jeton Twitch (tentative ${retryCount + 1}/${maxRetries})`);
          try {
            const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await refreshAccessToken(twitchRefreshToken);
            twitchAccessToken = newAccessToken;
            twitchRefreshToken = newRefreshToken || twitchRefreshToken; // Garder l'ancien refreshToken si non fourni
            await saveTwitchTokens(); // Sauvegarder les nouveaux jetons
            console.log(`[${new Date().toISOString()}]✅ Twitch Token Refresh, Get Followed Stream Retry`);
            // Réessayer avec le nouveau jeton
            return await getFollowedStreams(newAccessToken, cursor, retryCount + 1);
          } catch (refreshError) {
            console.error(`[${new Date().toISOString()}]❌ Échec du rafraîchissement du jeton Twitch:`, refreshError.message);
            throw refreshError;
          }
        }
      }
      throw error; // Propager les autres erreurs ou si maxRetries est atteint
    }
  } while (nextCursor);
  
  return { data: allStreams };
}

// Charger les jetons YouTube depuis MongoDB
async function loadYoutubeTokens() {
  try {
    const tokenDoc = await TokenApi.findOne({ platform: 'youtube' });
    if (tokenDoc) {
      youtubeAccessToken = tokenDoc.accessToken;
      youtubeRefreshToken = tokenDoc.refreshToken;
      console.log(`[${new Date().toISOString()}]📡 YT Token Loaded (MongoDB) (accessToken=${!!youtubeAccessToken}, refreshToken=${!!youtubeRefreshToken})`);
    } else {
      console.log(`[${new Date().toISOString()}]❌ YT Token Missing `);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Token read error (MongoDB) :`, error.message);
  }
}

// Sauvegarder les jetons YouTube dans MongoDB
async function saveYoutubeTokens() {
  try {
    const tokenData = {
      platform: 'youtube',
      accessToken: youtubeAccessToken,
      refreshToken: youtubeRefreshToken,
      expiresIn: 3600, // Ajustez cette valeur si nécessaire
      lastUpdated: new Date()
    };
    await TokenApi.updateOne({ platform: 'youtube' }, tokenData, { upsert: true });
    console.log(`[${new Date().toISOString()}]💾 YT Token Saved (MongoDB)`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la sauvegarde des jetons YouTube dans MongoDB:`, error.message);
  }
}

// Charger les jetons Twitch depuis MongoDB
async function loadTwitchTokens() {
  try {
    const tokenDoc = await TokenApi.findOne({ platform: 'twitch' });
    if (tokenDoc) {
      twitchAccessToken = tokenDoc.accessToken;
      twitchRefreshToken = tokenDoc.refreshToken;
      twitchUserId = tokenDoc.userId; // Correction : utiliser tokenDoc au lieu de twitchTokens
      console.log(`[${new Date().toISOString()}]📡 TW Token Loaded (MongoDB) (accessToken=${!!twitchAccessToken}, refreshToken=${!!twitchRefreshToken}, userId=${!!twitchUserId})`);
    } else {
      console.log(`[${new Date().toISOString()}]❌ Twitch Token Missing (MongoDB)`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Twitch Token Read Error (MongoDB) :`, error.message);
  }
}

// Sauvegarder les jetons Twitch dans MongoDB
async function saveTwitchTokens() {
  try {
    const tokenData = {
      platform: 'twitch',
      accessToken: twitchAccessToken,
      refreshToken: twitchRefreshToken,
      expiresIn: 3600, // Ajustez cette valeur si nécessaire
      lastUpdated: new Date()
    };
    await TokenApi.updateOne({ platform: 'twitch' }, tokenData, { upsert: true });
    console.log(`[${new Date().toISOString()}]💾 Twitch Token Saved (MongoDB)`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Twitch Token Save Error (MongoDB):`, error.message);
  }
}

// Vérification des variables d'environnement
if (!clientId || !clientSecret) {
  console.error(`[${new Date().toISOString()}]❌ Error : TWITCH_CLIENT_ID ou TWITCH_CLIENT_SECRET missing in .env`);
  process.exit(1);
}
if (!youtubeClientId || !youtubeClientSecret) {
  console.error(`[${new Date().toISOString()}]❌ Error : YOUTUBE_CLIENT_ID ou YOUTUBE_CLIENT_SECRET missing in .env`);
  process.exit(1);
}

// Middleware
app.use(express.static("public"));
app.use(cookieParser());
app.use(express.json());

// Rate limiting pour /refresh-token
const refreshTokenLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 1,
  message: { error: "❌ Refresh Token TimeOut, 5s wait" },
  keyGenerator: (req) => req.ip,
});
app.use("/refresh-token", refreshTokenLimiter);

// Stockage des paramètres de notification et chaînes YouTube
let notificationSettings = [];
let youtubeChannels = [];

// Charger les paramètres de notification depuis MongoDB
async function loadNotificationSettings() {
  try {
    const settings = await ChannelsBells.find({});    
    return settings.map(setting => ({
      userId: setting.userId,
      settingKey: `${setting.platform}_${setting.channelId}`,
      notificationsEnabled: setting.notificationsEnabled
    }));
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la lecture des paramètres de notification depuis ChannelsBells:`, error.message);
    return [];
  }
}

// Sauvegarder les paramètres de notification dans MongoDB
async function saveNotificationSettings(settings) {
  try {
    const operations = settings.map(setting => ({
      updateOne: {
        filter: { userId: setting.userId, platform: setting.settingKey.split('_')[0], channelId: setting.settingKey.split('_')[1] },
        update: { $set: { notificationsEnabled: setting.notificationsEnabled } },
        upsert: true
      }
    }));
    await ChannelsBells.bulkWrite(operations);    
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la sauvegarde des paramètres de notification dans ChannelsBells:`, error.message);
  }
}

// Charger les paramètres et jetons au démarrage
(async () => {  

  notificationSettings = await loadNotificationSettings();
  youtubeChannels = await loadYoutubeChannels();

  await loadYoutubeTokens();
  await loadTwitchTokens();

  console.log(`[${new Date().toISOString()}]✅ Token Initialisation | YT Token: ${!!youtubeAccessToken} | TW Token: ${!!twitchAccessToken}`);

  // Lancement du scraper dynamique YouTube
  scheduleYoutubeScraper();
})();

// Fonction pour rafraîchir le jeton d'accès Twitch
async function refreshAccessToken(refreshToken) {
  try {
    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      null,
      {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    if (!access_token) {
      throw new Error("❌ Aucun jeton d’accès reçu lors du rafraîchissement");
    }

    return {
      accessToken: access_token,
      refreshToken: refresh_token || refreshToken,
      expiresIn: expires_in,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement du jeton Twitch:`, error.message);
    throw error;
  }
}

// Fonction pour rafraîchir le jeton d'accès YouTube
async function refreshYoutubeAccessToken(refreshToken) {
  console.log(`[${new Date().toISOString()}]🔄 Tentative de rafraîchissement du jeton YouTube avec refresh_token`);
  try {
    const response = await axios.post(
      "https://oauth2.googleapis.com/token",
      null,
      {
        params: {
          client_id: youtubeClientId,
          client_secret: youtubeClientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        },
      }
    );

    const { access_token, expires_in } = response.data;
    if (!access_token) {
      throw new Error("❌ Aucun jeton d’accès reçu lors du rafraîchissement");
    }

    youtubeAccessToken = access_token;
    await saveYoutubeTokens();
    console.log(`[${new Date().toISOString()}] Jeton YouTube rafraîchi avec succès, expires_in: ${expires_in}`);
    return {
      accessToken: access_token,
      expiresIn: expires_in,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement du jeton YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur de rafraîchissement:`, error.response.data.error?.message || error.response.data);
    }
    throw error;
  }
}
// ============= startYoutubeTokenRefresh() n'est plus utilisé
async function startYoutubeTokenRefresh() {
  cron.schedule("*/30 * * * *", async () => {    
    if (!youtubeRefreshToken) {
      console.error(`[${new Date().toISOString()}]❌ Aucun refresh_token YouTube disponible`);
      return;
    }
    try {
      await refreshYoutubeAccessToken(youtubeRefreshToken);
      console.log(`[${new Date().toISOString()}]✅ YT Token Refresh`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}]❌ YT Token Refresh Error :`, error.response?.data?.error?.message || error.message);
    }
  });
}

// Endpoint pour initier l'authentification Twitch
app.get("/auth/twitch", (req, res) => {
  const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
    redirectUri
  )}&response_type=code&scope=${encodeURIComponent(scope)}`;
  console.log(`[${new Date().toISOString()}] Auth URL Twitch générée`);
  res.redirect(authUrl);
});

// Endpoint pour gérer le callback OAuth Twitch
app.get("/auth/twitch/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) {
        console.error(`[${new Date().toISOString()}]❌ Aucun code fourni dans /auth/twitch/callback`);
        return res.status(400).send("❌Aucun code d'autorisation fourni");
    }

    try {
        console.log(`[${new Date().toISOString()}]🔄 /auth/twitch/callback code: ${code}`);
        const tokenResponse = await axios.post("https://id.twitch.tv/oauth2/token", null, {
            params: {
                client_id: process.env.TWITCH_CLIENT_ID,
                client_secret: process.env.TWITCH_CLIENT_SECRET,
                code,
                grant_type: "authorization_code",
                redirect_uri: `${APP_URL}/auth/twitch/callback`,
            },
        });
        const { access_token, refresh_token } = tokenResponse.data;
        console.log(`[${new Date().toISOString()}] Jetons Twitch reçus: access_token=${!!access_token}, refresh_token=${!!refresh_token}`);

        // Récupérer l'ID utilisateur
        const userResponse = await axios.get("https://api.twitch.tv/helix/users", {
            headers: {
                "Client-ID": process.env.TWITCH_CLIENT_ID,
                Authorization: `Bearer ${access_token}`,
            },
        });
        const userId = userResponse.data.data[0]?.id;
        console.log(`[${new Date().toISOString()}] ID utilisateur Twitch récupéré: ${userId}`);

        if (!userId) {
            throw new Error("❌ Impossible de récupérer l'ID utilisateur Twitch");
        }

        // Stocker les jetons et l'ID utilisateur dans MongoDB
        await TokenApi.updateOne(
            { platform: 'twitch' },
            { $set: { accessToken: access_token, refreshToken: refresh_token, userId, expiresIn: 3600, lastUpdated: new Date() } },
            { upsert: true }
        );
        console.log(`[${new Date().toISOString()}] Jetons et userId sauvegardés dans MongoDB`);

        twitchAccessToken = access_token;
        twitchRefreshToken = refresh_token;
        twitchUserId = userId;

        console.log(`[${new Date().toISOString()}] Authentification Twitch réussie, userId: ${userId}`);
        res.redirect("/");
    } catch (error) {
        console.error(`[${new Date().toISOString()}]❌ Erreur dans /auth/twitch/callback:`, error.message);
        if (error.response) {
            console.error(`[${new Date().toISOString()}] Détails de l'erreur API:`, error.response.status, error.response.data);
        }
        res.status(500).send("❌ Erreur lors de l'authentification Twitch");
    }
});

// Endpoint pour initier l'authentification YouTube
app.get("/auth/youtube", (req, res) => {
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${youtubeClientId}&redirect_uri=${encodeURIComponent(
    youtubeRedirectUri
  )}&response_type=code&scope=${encodeURIComponent(
    youtubeScope
  )}&access_type=offline&prompt=consent`;
  console.log(`[${new Date().toISOString()}] Auth URL YouTube générée`);
  res.redirect(authUrl);
});

// Endpoint pour gérer le callback OAuth YouTube
app.get("/auth/youtube/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    console.error(`[${new Date().toISOString()}]❌ Aucun code fourni dans /auth/youtube/callback`);
    return res.status(400).json({ error: "Aucun code fourni" });
  }

  try {
    console.log(`[${new Date().toISOString()}] Échange du code OAuth YouTube, redirect_uri: ${youtubeRedirectUri}`);
    const response = await axios.post(
      "https://oauth2.googleapis.com/token",
      null,
      {
        params: {
          client_id: youtubeClientId,
          client_secret: youtubeClientSecret,
          code: code,
          grant_type: "authorization_code",
          redirect_uri: youtubeRedirectUri,
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    if (!access_token || !refresh_token) {
      throw new Error("Aucun jeton d’accès ou refresh_token reçu");
    }

    youtubeAccessToken = access_token;
    youtubeRefreshToken = refresh_token;
    await saveYoutubeTokens();

    const subscriptions = await getYoutubeSubscriptions(access_token);
    youtubeChannels = subscriptions;
    await saveYoutubeChannels(subscriptions);

    console.log(`[${new Date().toISOString()}] Authentification YouTube réussie, ${subscriptions.length} chaînes récupérées`);
    res.redirect("/index.html");
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de l’échange du jeton YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur:`, error.response.status, error.response.data.error?.message || error.response.data);
    }
    res.status(500).json({ error: "❌ Erreur lors de l’authentification YouTube" });
  }
});

// Fonction pour récupérer les abonnements YouTube
async function getYoutubeSubscriptions(accessToken) {
  try {
    let allSubscriptions = [];
    let nextPageToken = null;

    do {
      const response = await axios.get(
        "https://www.googleapis.com/youtube/v3/subscriptions",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            part: "snippet",
            mine: true,
            maxResults: 50,
            pageToken: nextPageToken,
          },
        }
      );

      const subscriptions = response.data.items.map((item) => ({
        channelId: item.snippet.resourceId.channelId,
        subscriptionDate: item.snippet.publishedAt || null,
      }));

      allSubscriptions = allSubscriptions.concat(subscriptions);
      nextPageToken = response.data.nextPageToken || null;
    } while (nextPageToken);

    const channelDetails = [];
    for (let i = 0; i < allSubscriptions.length; i += 50) {
      const batch = allSubscriptions.slice(i, i + 50);
      const channelIds = batch.map((sub) => sub.channelId).join(",");

      const channelsResponse = await axios.get(
        "https://www.googleapis.com/youtube/v3/channels",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            part: "snippet,statistics,brandingSettings",
            id: channelIds,
            maxResults: 50,
          },
        }
      );

      channelsResponse.data.items.forEach((channel) => {
        const sub = allSubscriptions.find((s) => s.channelId === channel.id);
        const snippet = channel.snippet || {};
        const statistics = channel.statistics || {};
        const brandingSettings = channel.brandingSettings || {};

        channelDetails.push({
          channelId: channel.id,
          customUrl: snippet.customUrl || "",
          title: snippet.title || "Unknown",
          thumbnail: snippet.thumbnails?.high?.url || "",
          bannerExternalUrl: brandingSettings.image?.bannerExternalUrl || "",
          subscriptionDate: sub.subscriptionDate ? new Date(sub.subscriptionDate) : null,
          publishedAt: snippet.publishedAt ? new Date(snippet.publishedAt) : null,
          subscriberCount: statistics.subscriberCount || "0",
          viewCount: statistics.viewCount || "0",
          country: snippet.country || "",
        });
      });
    }

    console.log(`[${new Date().toISOString()}]📡 YT Channels (YT_API) : ${channelDetails.length}`);
    return channelDetails;
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des abonnements YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur API:`, error.response.status, error.response.data.error?.message || error.response.data);
    }
    throw error;
  }
}

// Fonction pour exécuter le script Python
// Fonction pour exécuter le script Python
async function runPythonScript(accessToken, retryCount = 0) {
    const maxRetries = 1;
    if (!accessToken) {
        console.error(`[${new Date().toISOString()}]❌ Aucun jeton d'accès YouTube disponible`);
        return 0;
    }

    const scriptPath = path.join(__dirname, "scripts", "YTScraper.py");
    const command = `python ${scriptPath} --access-token ${accessToken}`;

    const startTime = Date.now();

    try {
        const { stdout, stderr } = await execPromise(command);
        const duration = Math.floor((Date.now() - startTime) / 1000);

        if (stdout) console.log(stdout.trim());
        if (stderr) console.error(`[${new Date().toISOString()}] stderr Python: ${stderr.trim()}`);

        return duration;

    } catch (error) {
        const duration = Math.floor((Date.now() - startTime) / 1000);
        console.error(`[${new Date().toISOString()}]❌ Erreur Python (${duration}s): ${error.message}`);

        if (error.stdout) console.log("STDOUT:", error.stdout.trim());
        if (error.stderr) console.error("STDERR:", error.stderr.trim());

        const isTokenError = error.message.includes("401") || 
                           error.stdout?.includes("400 Client Error") || 
                           error.stdout?.includes("❌ Token invalide");

        if (isTokenError && youtubeRefreshToken && retryCount < maxRetries) {
            console.log(`[${new Date().toISOString()}]🔄 Token invalide → Rafraîchissement...`);
            try {
                const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
                youtubeAccessToken = newAccessToken;
                await saveYoutubeTokens();
                return await runPythonScript(newAccessToken, retryCount + 1);
            } catch (refreshError) {
                console.error(`[${new Date().toISOString()}]❌ Échec rafraîchissement:`, refreshError.message);
                throw refreshError;
            }
        }
        throw error;
    }
}

app.post("/run-python", async (req, res) => {
  console.log(`[${new Date().toISOString()}]🔄 /run-python`);
  if (!youtubeAccessToken) {
    console.error(`[${new Date().toISOString()}]❌ Aucun jeton d’accès YouTube disponible`);
    return res.status(401).json({ error: "❌ Aucun jeton YouTube disponible, veuillez vous connecter via /auth/youtube" });
  }

  try {
    await runPythonScript(youtubeAccessToken);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur dans /run-python:`, error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint pour récupérer le jeton Twitch
app.get("/get-token", async (req, res) => {
  if (!twitchAccessToken && twitchRefreshToken) {
    try {
      const { accessToken: newAccessToken, refreshToken: newRefreshToken } = await refreshAccessToken(twitchRefreshToken);
      twitchAccessToken = newAccessToken;
      twitchRefreshToken = newRefreshToken;
      await saveTwitchTokens();
      console.log(`[${new Date().toISOString()}]✅ Jeton Twitch rafraîchi avec succès dans /get-token`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement dans /get-token:`, error.message);
      return res.status(401).json({ error: "❌ Jeton Twitch invalide, veuillez vous reconnecter via /auth/twitch" });
    }
  }

  res.json({ access_token: twitchAccessToken || null });
});

// Endpoint pour récupérer le jeton YouTube
app.get("/get-youtube-token", async (req, res) => {
  if (!youtubeAccessToken && youtubeRefreshToken) {
    try {
      const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
      youtubeAccessToken = newAccessToken;
    } catch (error) {
      console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement du jeton YouTube dans /get-youtube-token:`, error.message);
      return res.status(401).json({ error: "❌ Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
    }
  }

  res.json({ access_token: youtubeAccessToken || null });
});

// Endpoint pour rafraîchir le jeton Twitch côté client
app.get("/refresh-token", async (req, res) => {
  const clientIp = req.ip;
  console.log(`[${new Date().toISOString()}]🔄 /refresh-token IP: ${clientIp}`);

  if (!twitchRefreshToken) {
    console.error(`[${new Date().toISOString()}]❌ Aucun refresh_token disponible dans /refresh-token, IP: ${clientIp}`);
    return res.status(401).json({ error: "❌ Aucun refresh_token Twitch disponible, veuillez vous connecter via /auth/twitch" });
  }

  try {
    const { accessToken, refreshToken: newRefreshToken, expiresIn } = await refreshAccessToken(twitchRefreshToken);
    twitchAccessToken = accessToken;
    twitchRefreshToken = newRefreshToken;
    await saveTwitchTokens();

    console.log(`[${new Date().toISOString()}]✅ Jeton Twitch rafraîchi avec succès dans /refresh-token, IP: ${clientIp}, expires_in: ${expiresIn}`);
    res.json({ access_token: accessToken });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement du jeton dans /refresh-token, IP: ${clientIp}:`, error.message);
    res.status(401).json({ error: "❌ Jeton Twitch invalide, veuillez vous reconnecter via /auth/twitch" });
  }
});

//endpoint
app.get('/get-recent-notifications', async (req, res) => {
  try {
    // Récupérer les notifications des dernières 5 minutes pour limiter les données
    const recentTimestamp = Date.now() - 5 * 60 * 1000;
    const notifications = await Notification.find({
      timestamp: { $gte: recentTimestamp }
    }).sort({ timestamp: -1 }).limit(50);
    
    console.log(`[${new Date().toISOString()}]🔄 /get-recent-notifications : ${notifications.length}`);
    res.json(notifications);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des notifications:`, error.message);
    res.status(500).json({ error: '❌ Erreur serveur lors de la récupération des notifications' });
  }
});

// Endpoint pour récupérer les chaînes YouTube abonnées
app.get("/get-youtube-channels", async (req, res) => {
  
  if (!youtubeAccessToken && !youtubeRefreshToken) {
    console.warn(`[${new Date().toISOString()}]❌ Aucun jeton d’accès ou refresh token disponible, renvoi d’une liste vide`);
    return res.status(401).json({ error: "❌ Aucun jeton YouTube disponible, veuillez vous connecter via /auth/youtube" });
  }

  if (!youtubeAccessToken && youtubeRefreshToken) {
    console.log(`[${new Date().toISOString()}]❌ Jeton d’accès absent, tentative de rafraîchissement avec le refresh token`);
    try {
      const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
      youtubeAccessToken = newAccessToken;
      console.log(`[${new Date().toISOString()}] Jeton d’accès YouTube rafraîchi avec succès`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}]❌ Erreur lors du rafraîchissement du jeton YouTube dans /get-youtube-channels:`, error.message);
      if (error.response) {
        console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur de rafraîchissement:`, error.response.data.error?.message || error.response.data);
      }
      return res.status(401).json({ error: "❌ Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
    }
  }

  try {
    const subscriptions = await getYoutubeSubscriptions(youtubeAccessToken);
    youtubeChannels = subscriptions;
    await saveYoutubeChannels(subscriptions);    
    res.json(youtubeChannels);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des chaînes YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}]❌ Détails de l’erreur API:`, error.response.status, error.response.data.error?.message || error.response.data);
      if (error.response.status === 401 && youtubeRefreshToken) {
        console.log(`[${new Date().toISOString()}]❌ Erreur 401 détectée, nouvelle tentative de rafraîchissement`);
        try {
          const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
          youtubeAccessToken = newAccessToken;
          const subscriptions = await getYoutubeSubscriptions(newAccessToken);
          youtubeChannels = subscriptions;
          await saveYoutubeChannels(subscriptions);
          console.log(`[${new Date().toISOString()}] Chaînes YouTube récupérées après rafraîchissement: ${subscriptions.length} chaînes`);
          return res.json(youtubeChannels);
        } catch (refreshError) {
          console.error(`[${new Date().toISOString()}]❌ Échec du rafraîchissement après erreur 401:`, refreshError.message);
          return res.status(401).json({ error: "❌ Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
        }
      }
    }
    res.json(youtubeChannels);
  }
});

// Endpoint pour récupérer les paramètres de notification
app.get("/get-notifications", async (req, res) => {
  const userId = req.query.userId;
  
  if (!userId) {
    console.error(`[${new Date().toISOString()}]🔄 /get-notifications userId manquant`);
    return res.status(400).json({ error: "/get-notifications userId manquant" });
  }

  try {
    const settings = await ChannelsBells.find({ userId });
    const formattedSettings = settings.map(setting => ({
      platform: setting.platform,
      channelId: setting.channelId,
      notificationsEnabled: setting.notificationsEnabled
    }));
    console.log(`[${new Date().toISOString()}]🛎️ Bell Notification read : ${formattedSettings.length}`);
    res.json(formattedSettings);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des paramètres de notification:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de la récupération des notifications" });
  }
});

// Endpoint pour mettre à jour les paramètres de notification
app.post("/set-notification", async (req, res) => {
  const { userId, platform, channelId, notificationsEnabled } = req.body;

  console.log(`[${new Date().toISOString()}]🔄 /set-notification:`, { userId, platform, channelId, notificationsEnabled });

  if (!userId || !platform || !channelId || typeof notificationsEnabled !== "boolean") {
    console.error(`[${new Date().toISOString()}]❌ Paramètres invalides:`, { userId, platform, channelId, notificationsEnabled });
    return res.status(400).json({ error: "❌ Paramètres manquants ou invalides" });
  }

  try {
    await ChannelsBells.updateOne(
      { userId, platform, channelId },
      { $set: { notificationsEnabled, timestamps: true } },
      { upsert: true }
    );
    console.log(`[${new Date().toISOString()}]🔄 Notification Updated in ChannelsBells :`, { userId, platform, channelId, notificationsEnabled });
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la mise à jour des paramètres de notification:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de la mise à jour des notifications" });
  }
});

// Endpoint pour sauvegarder une notification dans MongoDB
app.post("/save-notification-log", async (req, res) => {
  const notification = req.body;
  if (
    !notification.id ||
    !notification.user_id ||
    !notification.user_name ||
    !notification.title ||
    !notification.avatar_url ||
    !notification.timestamp
  ) {
    console.error(`[${new Date().toISOString()}]❌ Données de notification invalides:`, {
      receivedKeys: Object.keys(notification),
      missingKeys: [
        !notification.id && "id",
        !notification.user_id && "user_id",
        !notification.user_name && "user_name",
        !notification.title && "title",
        !notification.avatar_url && "avatar_url",
        !notification.timestamp && "timestamp",
      ].filter(Boolean),
    });
    return res.status(400).json({ error: "❌ Données de notification invalides" });
  }

  try {
    await saveNotificationLog(notification);
    notificationEmitter.emit("new-notification", notification);
    console.log(`[${new Date().toISOString()}] Notification émise:`, notification); // Log ajouté
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de l’enregistrement de la notification:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de l’enregistrement de la notification" });
  }
});

// Endpoint pour récupérer le journal des notifications depuis MongoDB
app.get("/get-notification-log", async (req, res) => {
  try {
    const notificationLog = await loadNotificationLog();
    console.log(`[${new Date().toISOString()}]📖 Notification Log : ${notificationLog.length}`);
    res.json(notificationLog);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération du journal des notifications:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de la récupération du journal des notifications" });
  }
});

// Endpoint pour le streaming des notifications
app.get('/notifications-stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendNotification = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const listener = (newNotification) => {
    sendNotification(newNotification);
  };

  notificationEmitter.on('new-notification', listener);

  // Ping toutes les 15 secondes pour maintenir la connexion
  const pingInterval = setInterval(() => {
    res.write(': ping\n\n'); // Commentaire vide pour garder la connexion active
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval); // Nettoyer l'intervalle quand la connexion se ferme
    notificationEmitter.off('new-notification', listener);
  });
});

// Route de secours pour la racine
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}]❌ Erreur de serveur:`, err.message);
  res.status(500).json({ error: "❌ Erreur serveur interne" });
});

app.get("/get-youtube-videos", async (req, res) => {
  console.log(`[${new Date().toISOString()}]🔄 /get-youtube-videos`);
  try {
    const videos = await YoutubeVideo.find({
      status: "upcoming"
    }).sort({ startTime: 1 });
    console.log(`[${new Date().toISOString()}]🔄 YT Vid : ${videos.length} (upcoming + live)`);
    res.json(videos);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des vidéos:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de la récupération des vidéos" });
  }
});

app.get("/get-live-streams", async (req, res) => {
  console.log(`[${new Date().toISOString()}]🔄 /get-live-streams`);
  try {
    const streams = await Live.find({}).sort({ started_at: -1 });
    console.log(`[${new Date().toISOString()}]🔴 Live (YT & TW) : ${streams.length}`);
    res.json(streams);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Erreur lors de la récupération des streams:`, error.message);
    res.status(500).json({ error: "❌ Erreur serveur lors de la récupération des streams" });
  }
});

// Endpoint pour déconnexion
app.get("/logout-api", async (req, res) => {
  twitchAccessToken = null;
  twitchRefreshToken = null;
  youtubeAccessToken = null;
  youtubeRefreshToken = null;
  await saveTwitchTokens();
  await saveYoutubeTokens();
  console.log(`[${new Date().toISOString()}] Déconnexion API: tous les jetons réinitialisés`);
  res.redirect("/");
});

// ====================== CRONS (UNIFIÉS) ======================

// Cron Dynamique YouTube
function scheduleYoutubeScraper() {
    if (currentYoutubeCron) {
        currentYoutubeCron.stop();
    }

    const scrapMinutes = Math.ceil(lastScrapDurationSeconds / 60);
    let intervalMinutes = Math.max(3, Math.min(12, scrapMinutes + 1));   

    currentYoutubeCron = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
        console.log(`[${new Date().toISOString()}]⏱️ YT Scraper Set ${intervalMinutes}min (Last ScrapTime : ${lastScrapDurationSeconds}s)`);

        if (!youtubeAccessToken && youtubeRefreshToken) {
            console.log(`[${new Date().toISOString()}] Rafraîchissement du jeton YouTube...`);
            try {
                const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
                youtubeAccessToken = newAccessToken;
            } catch (error) {
                console.error(`[${new Date().toISOString()}]❌ Échec rafraîchissement jeton:`, error.message);
                return;
            }
        }

        if (!youtubeAccessToken) {
            console.error(`[${new Date().toISOString()}]❌ Aucun jeton YouTube disponible`);
            return;
        }

        try {
            const startScrap = Date.now();
            const duration = await runPythonScript(youtubeAccessToken);

            lastScrapDurationSeconds = duration > 0 ? duration : Math.floor((Date.now() - startScrap) / 1000);

            // Re-planifier avec la nouvelle durée
            scheduleYoutubeScraper();
        } catch (error) {
            console.error(`[${new Date().toISOString()}]❌ Erreur critique scraper:`, error.message);
        }
    });
}

// Synchronisation Live Twitch + YouTube toutes les minutes
cron.schedule('*/1 * * * *', async () => {
  
  await Promise.all([
    syncTwitchLiveStreams().catch(err => console.error("TW Sync Error:", err.message)),
    syncYoutubeLiveVideos().catch(err => console.error("YT Sync Error:", err.message))
  ]);
  console.log(`[${new Date().toISOString()}]🔄 Live Refresh (TW & YT)`);
});

// Auto-ping pour éviter le spindown (Render, Railway, etc.)
cron.schedule('*/10 * * * *', async () => {
  try {
    const response = await axios.get(APP_URL);
    console.log(`[${new Date().toISOString()}]✅ Auto-ping OK → ${response.status}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}]❌ Auto-ping échoué:`, error.message);
  }
});

// Lancement initial du cron dynamique YouTube
scheduleYoutubeScraper();

// Démarrer le serveur
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[${new Date().toISOString()}]✅ Server listening (port ${port})`);
});
