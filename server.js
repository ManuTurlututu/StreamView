require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cookieParser = require("cookie-parser");
const fs = require("fs").promises;
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

// Middleware
app.use(cors({
  origin: 'https://streamview0.loca.lt', // Remplacez par votre URL loca.lt ou '*' pour autoriser toutes les origines
  methods: ['GET', 'POST'],
}));


// Configuration
const clientId = process.env.TWITCH_CLIENT_ID;
const clientSecret = process.env.TWITCH_CLIENT_SECRET;
const redirectUri = process.env.TWITCH_REDIRECT_URI;
const scope = "user:read:follows";

const youtubeClientId = process.env.YOUTUBE_CLIENT_ID;
const youtubeClientSecret = process.env.YOUTUBE_CLIENT_SECRET;
const youtubeRedirectUri = process.env.YOUTUBE_REDIRECT_URI;
const youtubeScope = "https://www.googleapis.com/auth/youtube.readonly";

const NOTIFICATIONS_FILE = path.join(__dirname, "notifications.json");

// Variables globales pour stocker les jetons
let youtubeAccessToken = null;
let youtubeRefreshToken = null;
let twitchAccessToken = null;
let twitchRefreshToken = null;

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(() => console.log(`[${new Date().toISOString()}] Connecté à MongoDB`))
.catch(error => console.error(`[${new Date().toISOString()}] Erreur de connexion à MongoDB:`, error.message));

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
  platform: { type: String, required: true, unique: true }, // 'twitch' ou 'youtube'
  accessToken: { type: String, required: true },
  refreshToken: { type: String, required: true },
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
  timestamp: { type: String, required: true }
}, { collection: 'youtubeVideos' }); // Forcer le nom de la collection

const YoutubeVideo = mongoose.model('YoutubeVideo', youtubeVideoSchema);

// Charger les notifications depuis MongoDB (uniquement les 7 derniers jours)
async function loadNotificationLog() {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const notifications = await Notification.find({ timestamp: { $gt: sevenDaysAgo } }).sort({ timestamp: -1 });
    return notifications;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la lecture des notifications depuis MongoDB:`, error.message);
    return [];
  }
}

// Sauvegarder une notification dans MongoDB
async function saveNotificationLog(notification) {
  try {
    const newNotification = new Notification(notification);
    await newNotification.save();
    console.log(`[${new Date().toISOString()}] Notification enregistrée dans MongoDB:`, { id: notification.id, user_name: notification.user_name });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la sauvegarde de la notification dans MongoDB:`, error.message);
  }
}

// Charger les chaînes YouTube depuis MongoDB
async function loadYoutubeChannels() {
  try {
    const channels = await YoutubeChannel.find({});
    return channels;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la lecture des chaînes YouTube depuis MongoDB:`, error.message);
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
    console.log(`[${new Date().toISOString()}] Chaînes YouTube sauvegardées dans MongoDB: ${channels.length} chaînes`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la sauvegarde des chaînes YouTube dans MongoDB:`, error.message);
  }
}

// Charger les jetons YouTube depuis MongoDB
async function loadYoutubeTokens() {
  try {
    const tokenDoc = await TokenApi.findOne({ platform: 'youtube' });
    if (tokenDoc) {
      youtubeAccessToken = tokenDoc.accessToken;
      youtubeRefreshToken = tokenDoc.refreshToken;
      console.log(`[${new Date().toISOString()}] Jetons YouTube chargés depuis MongoDB: accessToken=${!!youtubeAccessToken}, refreshToken=${!!youtubeRefreshToken}`);
    } else {
      console.log(`[${new Date().toISOString()}] Aucun jeton YouTube trouvé dans MongoDB`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la lecture des jetons YouTube depuis MongoDB:`, error.message);
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
    console.log(`[${new Date().toISOString()}] Jetons YouTube sauvegardés dans MongoDB`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la sauvegarde des jetons YouTube dans MongoDB:`, error.message);
  }
}

// Charger les jetons Twitch depuis MongoDB
async function loadTwitchTokens() {
  try {
    const tokenDoc = await TokenApi.findOne({ platform: 'twitch' });
    if (tokenDoc) {
      twitchAccessToken = tokenDoc.accessToken;
      twitchRefreshToken = tokenDoc.refreshToken;
      console.log(`[${new Date().toISOString()}] Jetons Twitch chargés depuis MongoDB: accessToken=${!!twitchAccessToken}, refreshToken=${!!twitchRefreshToken}`);
    } else {
      console.log(`[${new Date().toISOString()}] Aucun jeton Twitch trouvé dans MongoDB`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la lecture des jetons Twitch depuis MongoDB:`, error.message);
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
    console.log(`[${new Date().toISOString()}] Jetons Twitch sauvegardés dans MongoDB`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la sauvegarde des jetons Twitch dans MongoDB:`, error.message);
  }
}

// Vérification des variables d'environnement
if (!clientId || !clientSecret) {
  console.error(`[${new Date().toISOString()}] Erreur : TWITCH_CLIENT_ID ou TWITCH_CLIENT_SECRET manquant dans .env`);
  process.exit(1);
}
if (!youtubeClientId || !youtubeClientSecret) {
  console.error(`[${new Date().toISOString()}] Erreur : YOUTUBE_CLIENT_ID ou YOUTUBE_CLIENT_SECRET manquant dans .env`);
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
  message: { error: "Trop de requêtes de rafraîchissement, réessayez dans 5 secondes" },
  keyGenerator: (req) => req.ip,
});
app.use("/refresh-token", refreshTokenLimiter);

// Stockage des paramètres de notification et chaînes YouTube
let notificationSettings = [];
let youtubeChannels = [];

// Fonction pour charger les paramètres de notification depuis le fichier
async function loadNotificationSettings() {
  try {
    const data = await fs.readFile(NOTIFICATIONS_FILE, "utf8");
    return JSON.parse(data) || [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error(`[${new Date().toISOString()}] Erreur lors de la lecture de notifications.json:`, error.message);
    return [];
  }
}

// Fonction pour sauvegarder les paramètres de notification dans le fichier
async function saveNotificationSettings(settings) {
  try {
    await fs.writeFile(NOTIFICATIONS_FILE, JSON.stringify(settings, null, 2));
    console.log(`[${new Date().toISOString()}] Paramètres de notification sauvegardés dans notifications.json`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la sauvegarde de notifications.json:`, error.message);
  }
}

// Charger les paramètres et jetons au démarrage
(async () => {
  notificationSettings = await loadNotificationSettings();
  console.log(`[${new Date().toISOString()}] Paramètres de notification chargés: ${notificationSettings.length} paramètres`);
  youtubeChannels = await loadYoutubeChannels();
  console.log(`[${new Date().toISOString()}] Chaînes YouTube chargées: ${youtubeChannels.length} chaînes`);
  await loadYoutubeTokens();
  await loadTwitchTokens();
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
      throw new Error("Aucun jeton d’accès reçu lors du rafraîchissement");
    }

    return {
      accessToken: access_token,
      refreshToken: refresh_token || refreshToken,
      expiresIn: expires_in,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton Twitch:`, error.message);
    throw error;
  }
}

// Fonction pour rafraîchir le jeton d'accès YouTube
async function refreshYoutubeAccessToken(refreshToken) {
  console.log(`[${new Date().toISOString()}] Tentative de rafraîchissement du jeton YouTube avec refresh_token`);
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
      throw new Error("Aucun jeton d’accès reçu lors du rafraîchissement");
    }

    youtubeAccessToken = access_token;
    await saveYoutubeTokens();
    console.log(`[${new Date().toISOString()}] Jeton YouTube rafraîchi avec succès, expires_in: ${expires_in}`);
    return {
      accessToken: access_token,
      expiresIn: expires_in,
    };
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}] Détails de l’erreur de rafraîchissement:`, error.response.data.error?.message || error.response.data);
    }
    throw error;
  }
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
  const code = req.query.code;
  if (!code) {
    console.error(`[${new Date().toISOString()}] Aucun code fourni dans /auth/twitch/callback`);
    return res.status(400).json({ error: "Aucun code fourni" });
  }

  try {
    const response = await axios.post(
      "https://id.twitch.tv/oauth2/token",
      null,
      {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          code: code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;
    if (!access_token || !refresh_token) {
      throw new Error("Aucun jeton d’accès ou refresh_token reçu");
    }

    twitchAccessToken = access_token;
    twitchRefreshToken = refresh_token;
    await saveTwitchTokens();

    console.log(`[${new Date().toISOString()}] Authentification Twitch réussie`);
    res.redirect("/index.html");
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de l’échange du jeton Twitch:`, error.message);
    res.status(500).json({ error: "Erreur lors de l’authentification Twitch" });
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
    console.error(`[${new Date().toISOString()}] Aucun code fourni dans /auth/youtube/callback`);
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
    console.error(`[${new Date().toISOString()}] Erreur lors de l’échange du jeton YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}] Détails de l’erreur:`, error.response.status, error.response.data.error?.message || error.response.data);
    }
    res.status(500).json({ error: "Erreur lors de l’authentification YouTube" });
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

    console.log(`[${new Date().toISOString()}] Récupéré ${channelDetails.length} chaînes YouTube`);
    return channelDetails;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération des abonnements YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}] Détails de l’erreur API:`, error.response.status, error.response.data.error?.message || error.response.data);
    }
    throw error;
  }
}

// Fonction pour exécuter le script Python
async function runPythonScript(accessToken) {
  if (!accessToken) {
    console.error(`[${new Date().toISOString()}] Aucun jeton d'accès YouTube disponible`);
    return;
  }

  const scriptPath = path.join(__dirname, "scripts", "YTScraper.py");
  const command = `python ${scriptPath} --access-token ${accessToken}`;

  try {
    const { stdout, stderr } = await execPromise(command);
    console.log(`[${new Date().toISOString()}] Script Python exécuté avec succès: ${stdout}`);
    if (stderr) {
      console.error(`[${new Date().toISOString()}] Erreur stderr du script Python: ${stderr}`);
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de l'exécution du script Python: ${error.message}`);
  }
}

// Planifier l'exécution toutes les 1 minute
cron.schedule("*/1 * * * *", async () => {
  console.log(`[${new Date().toISOString()}] Lancement du script Python planifié...`);
  if (!youtubeAccessToken && youtubeRefreshToken) {
    console.log(`[${new Date().toISOString()}] Jeton d'accès manquant, tentative de rafraîchissement...`);
    try {
      const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
      youtubeAccessToken = newAccessToken;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Échec du rafraîchissement du jeton YouTube:`, error.message);
    }
  }
  if (youtubeAccessToken) {
    await runPythonScript(youtubeAccessToken);
  } else {
    console.error(`[${new Date().toISOString()}] Impossible d'exécuter le script: aucun jeton disponible`);
  }
});

// Endpoint pour déclencher manuellement le script Python
app.post("/run-python", async (req, res) => {
  if (!youtubeAccessToken && youtubeRefreshToken) {
    try {
      const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
      youtubeAccessToken = newAccessToken;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton dans /run-python:`, error.message);
      return res.status(401).json({ error: "Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
    }
  }

  if (!youtubeAccessToken) {
    return res.status(401).json({ error: "Aucun jeton d’accès YouTube disponible, veuillez vous connecter via /auth/youtube" });
  }

  try {
    await runPythonScript(youtubeAccessToken);
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur dans /run-python:`, error.message);
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
      console.log(`[${new Date().toISOString()}] Jeton Twitch rafraîchi avec succès dans /get-token`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement dans /get-token:`, error.message);
      return res.status(401).json({ error: "Jeton Twitch invalide, veuillez vous reconnecter via /auth/twitch" });
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
      console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton YouTube dans /get-youtube-token:`, error.message);
      return res.status(401).json({ error: "Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
    }
  }

  res.json({ access_token: youtubeAccessToken || null });
});

// Endpoint pour rafraîchir le jeton Twitch côté client
app.get("/refresh-token", async (req, res) => {
  const clientIp = req.ip;
  console.log(`[${new Date().toISOString()}] Requête /refresh-token reçue de l'IP: ${clientIp}`);

  if (!twitchRefreshToken) {
    console.error(`[${new Date().toISOString()}] Aucun refresh_token disponible dans /refresh-token, IP: ${clientIp}`);
    return res.status(401).json({ error: "Aucun refresh_token Twitch disponible, veuillez vous connecter via /auth/twitch" });
  }

  try {
    const { accessToken, refreshToken: newRefreshToken, expiresIn } = await refreshAccessToken(twitchRefreshToken);
    twitchAccessToken = accessToken;
    twitchRefreshToken = newRefreshToken;
    await saveTwitchTokens();

    console.log(`[${new Date().toISOString()}] Jeton Twitch rafraîchi avec succès dans /refresh-token, IP: ${clientIp}, expires_in: ${expiresIn}`);
    res.json({ access_token: accessToken });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton dans /refresh-token, IP: ${clientIp}:`, error.message);
    res.status(401).json({ error: "Jeton Twitch invalide, veuillez vous reconnecter via /auth/twitch" });
  }
});

// Endpoint pour récupérer les chaînes YouTube abonnées
app.get("/get-youtube-channels", async (req, res) => {
  console.log(`[${new Date().toISOString()}] Requête /get-youtube-channels - Access token: ${youtubeAccessToken ? "Présent" : "Absent"}, Refresh token: ${youtubeRefreshToken ? "Présent" : "Absent"}`);

  if (!youtubeAccessToken && !youtubeRefreshToken) {
    console.warn(`[${new Date().toISOString()}] Aucun jeton d’accès ou refresh token disponible, renvoi d’une liste vide`);
    return res.status(401).json({ error: "Aucun jeton YouTube disponible, veuillez vous connecter via /auth/youtube" });
  }

  if (!youtubeAccessToken && youtubeRefreshToken) {
    console.log(`[${new Date().toISOString()}] Jeton d’accès absent, tentative de rafraîchissement avec le refresh token`);
    try {
      const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
      youtubeAccessToken = newAccessToken;
      console.log(`[${new Date().toISOString()}] Jeton d’accès YouTube rafraîchi avec succès`);
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Erreur lors du rafraîchissement du jeton YouTube dans /get-youtube-channels:`, error.message);
      if (error.response) {
        console.error(`[${new Date().toISOString()}] Détails de l’erreur de rafraîchissement:`, error.response.data.error?.message || error.response.data);
      }
      return res.status(401).json({ error: "Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
    }
  }

  try {
    const subscriptions = await getYoutubeSubscriptions(youtubeAccessToken);
    youtubeChannels = subscriptions;
    await saveYoutubeChannels(subscriptions);
    console.log(`[${new Date().toISOString()}] Chaînes YouTube mises à jour avec succès: ${subscriptions.length} chaînes`);
    res.json(youtubeChannels);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération des chaînes YouTube:`, error.message);
    if (error.response) {
      console.error(`[${new Date().toISOString()}] Détails de l’erreur API:`, error.response.status, error.response.data.error?.message || error.response.data);
      if (error.response.status === 401 && youtubeRefreshToken) {
        console.log(`[${new Date().toISOString()}] Erreur 401 détectée, nouvelle tentative de rafraîchissement`);
        try {
          const { accessToken: newAccessToken } = await refreshYoutubeAccessToken(youtubeRefreshToken);
          youtubeAccessToken = newAccessToken;
          const subscriptions = await getYoutubeSubscriptions(newAccessToken);
          youtubeChannels = subscriptions;
          await saveYoutubeChannels(subscriptions);
          console.log(`[${new Date().toISOString()}] Chaînes YouTube récupérées après rafraîchissement: ${subscriptions.length} chaînes`);
          return res.json(youtubeChannels);
        } catch (refreshError) {
          console.error(`[${new Date().toISOString()}] Échec du rafraîchissement après erreur 401:`, refreshError.message);
          return res.status(401).json({ error: "Jeton YouTube invalide, veuillez vous reconnecter via /auth/youtube" });
        }
      }
    }
    res.json(youtubeChannels);
  }
});

// Endpoint pour mettre à jour les paramètres de notification
app.post("/set-notification", async (req, res) => {
  const { userId, broadcasterId, notificationsEnabled } = req.body;

  console.log(`[${new Date().toISOString()}] Requête reçue pour /set-notification:`, { userId, broadcasterId, notificationsEnabled });

  if (!userId || !broadcasterId || typeof notificationsEnabled !== "boolean") {
    console.error(`[${new Date().toISOString()}] Paramètres invalides:`, { userId, broadcasterId, notificationsEnabled });
    return res.status(400).json({ error: "Paramètres manquants ou invalides" });
  }

  try {
    const existingSetting = notificationSettings.find(
      (setting) => setting.userId === userId && setting.broadcasterId === broadcasterId
    );

    if (existingSetting) {
      existingSetting.notificationsEnabled = notificationsEnabled;
    } else {
      notificationSettings.push({ userId, broadcasterId, notificationsEnabled });
    }

    await saveNotificationSettings(notificationSettings);
    console.log(`[${new Date().toISOString()}] Paramètres de notification mis à jour:`, { userId, broadcasterId, notificationsEnabled });
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la mise à jour des paramètres de notification:`, error.message);
    res.status(500).json({ error: "Erreur serveur lors de la mise à jour des notifications" });
  }
});

// Endpoint pour récupérer les paramètres de notification
app.get("/get-notifications", (req, res) => {
  const userId = req.query.userId;
  console.log(`[${new Date().toISOString()}] Requête reçue pour /get-notifications:`, { userId });

  if (!userId) {
    console.error(`[${new Date().toISOString()}] userId manquant`);
    return res.status(400).json({ error: "userId manquant" });
  }

  try {
    const settings = notificationSettings
      .filter((setting) => setting.userId === userId)
      .map((setting) => ({
        broadcasterId: setting.broadcasterId,
        notificationsEnabled: setting.notificationsEnabled,
      }));

    console.log(`[${new Date().toISOString()}] Paramètres de notification renvoyés: ${settings.length} paramètres`);
    res.json(settings);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération des paramètres de notification:`, error.message);
    res.status(500).json({ error: "Erreur serveur lors de la récupération des notifications" });
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
    console.error(`[${new Date().toISOString()}] Données de notification invalides:`, {
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
    return res.status(400).json({ error: "Données de notification invalides" });
  }

  try {
    await saveNotificationLog(notification);
    notificationEmitter.emit("new-notification", notification);
    console.log(`[${new Date().toISOString()}] Notification émise:`, notification); // Log ajouté
    res.json({ success: true });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de l’enregistrement de la notification:`, error.message);
    res.status(500).json({ error: "Erreur serveur lors de l’enregistrement de la notification" });
  }
});

// Endpoint pour récupérer le journal des notifications depuis MongoDB
app.get("/get-notification-log", async (req, res) => {
  try {
    const notificationLog = await loadNotificationLog();
    console.log(`[${new Date().toISOString()}] Journal des notifications affiché : ${notificationLog.length}`);
    res.json(notificationLog);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération du journal des notifications:`, error.message);
    res.status(500).json({ error: "Erreur serveur lors de la récupération du journal des notifications" });
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
  console.error(`[${new Date().toISOString()}] Erreur de serveur:`, err.message);
  res.status(500).json({ error: "Erreur serveur interne" });
});

// Endpoint pour récupérer les vidéos YouTube à venir
app.get("/get-upcoming-videos", async (req, res) => {
  console.log(`[${new Date().toISOString()}] Requête /get-upcoming-videos`);
  try {
    const upcomingVideos = await YoutubeVideo.find({ status: "upcoming" }).sort({ startTime: 1 });
    console.log(`[${new Date().toISOString()}] Vidéos à venir récupérées: ${upcomingVideos.length}`);
    res.json(upcomingVideos);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération des vidéos à venir:`, error.message);
    res.status(500).json({ error: "Erreur serveur lors de la récupération des vidéos à venir" });
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

// URL de votre application Render
const APP_URL = process.env.APP_URL || 'https://your-app-name.onrender.com';

// Configurer un cron job pour pinger l'application toutes les 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try {
    const response = await axios.get(APP_URL);
    console.log(`[${new Date().toISOString()}] Auto-ping réussi: Statut ${response.status}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de l'auto-ping:`, error.message);
  }
});

// Démarrer le serveur
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[${new Date().toISOString()}] Serveur en écoute sur le port ${port}`);
});
