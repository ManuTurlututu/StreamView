const clientId = "fwff5k4xwotxh84zfgo3hla684twde";
const countdownTimers = {};
const avatarCache = new Map();

let currentTwitchToken = null;
let currentYoutubeToken = null;
let currentStreams = [];
let currentFollowedChannels = [];
let currentYoutubeChannels = [];
let notificationLog = [];
let sortMode = localStorage.getItem('sortMode') || "viewers";
let sortChannelsMode = localStorage.getItem('sortChannelsMode') || "date";
let platformFilter = localStorage.getItem('platformFilter') || "all";
let durationAnimationFrame = null;
let lastDurationUpdate = 0;
let searchLiveQuery = "";
let searchChannelsQuery = ""; // Added to replace searchFollowQuery and searchYoutubeQuery
let searchNotificationsQuery = "";
let searchUpcomingQuery = "";
let notificationSettings = new Map();
let autoLaunchSettings = new Map();
let currentUpcomingStreams = [];
let lastNotificationIds = new Set();
let lastCheckTimestamp = Date.now();

function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatViewers(count) {
  if (count >= 1000) {
    return (count / 1000).toFixed(1).replace(".0", "") + " k";
  }
  return count.toString();
}

function updateSyncStatus() {
  fetch('/sync-status')
    .then(r => r.json())
    .then(data => {
      const now = Date.now();
      const fmt = (ts) => {
        if (!ts) return '--';
        const diff = Math.floor((now - new Date(ts).getTime()) / 60000);
        return `${diff}min`;
      };
      const ytMin = data.yt ? Math.floor((now - new Date(data.yt).getTime()) / 60000) : 999;
      const twMin = data.twitch ? Math.floor((now - new Date(data.twitch).getTime()) / 60000) : 999;
      document.getElementById('yt-sync-label').textContent = `YT : ${fmt(data.yt)}`;
      document.getElementById('tw-sync-label').textContent = `TW : ${fmt(data.twitch)}`;
      const bar = document.getElementById('sync-status-bar');
      bar.classList.toggle('stale', ytMin >= 5 || twMin >= 5);
      const fmtFull = (ts) => {
        if (!ts) return 'jamais';
        return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      };
    })
    .catch(() => {});
}

function displayError(message, listId) {
  const channelsList = document.getElementById(listId);
  if (channelsList) {
    channelsList.innerHTML = `<p class="error">${message}</p>`;
  }
  if (listId === "channels-list") {
    stopDurationUpdates();
  }
}

function updateLogoutButtonVisibility() {
  const twitchLogin = document.getElementById("twitch-login");
  const youtubeLogin = document.getElementById("youtube-login");
  const logoutApi = document.getElementById("logout-api");

  if (twitchLogin && youtubeLogin && logoutApi) {
    twitchLogin.style.display = currentTwitchToken ? "none" : "block";
    youtubeLogin.style.display = currentYoutubeToken ? "none" : "block";
    logoutApi.style.display = currentTwitchToken || currentYoutubeToken ? "block" : "none";
  } else {
    console.error("Un ou plusieurs éléments de connexion/déconnexion introuvables :", {
      twitchLogin: !!twitchLogin,
      youtubeLogin: !!youtubeLogin,
      logoutApi: !!logoutApi,
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // ==================== TAB SWITCHING ====================
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelector(".tab.active")?.classList.remove("active");
      document.querySelector(".tab-content.active")?.classList.remove("active");

      tab.classList.add("active");
      const tabContent = document.getElementById(tab.dataset.tab);
      if (!tabContent) return;

      tabContent.classList.add("active");

      // Gestion spécifique par onglet
      if (tab.dataset.tab === "live") {
        startDurationUpdates();
        filterStreams();                    // applique recherche + tri actuel
      } 
      else if (tab.dataset.tab === "channels") {
        stopDurationUpdates();
        displayChannels();                  // recharge avec le tri actuel
      } 
      else if (tab.dataset.tab === "notification-tab") {
        stopDurationUpdates();
        getNotificationLogFromServer();
        updateNotificationLog();
        filterNotifications();
      } 
      else if (tab.dataset.tab === "settings") {
        stopDurationUpdates();
        updateLogoutButtonVisibility();
      } 
      else if (tab.dataset.tab === "upcoming") {
        stopDurationUpdates();
        if (currentUpcomingStreams.length === 0) {
          getUpcomingVideos();
        } else {
          filterUpcomingStreams(searchUpcomingQuery);
        }
      }
    });
  });

  // ==================== TRIS & RECHERCHES ====================

  // === LIVE TAB ===
  const sortSelector = document.getElementById("sort-selector");
  if (sortSelector) {
    sortSelector.value = sortMode; // ← restaure le visuel
    sortSelector.addEventListener("change", (event) => {
      sortMode = event.target.value;
      localStorage.setItem('sortMode', sortMode);
      const channelsList = document.getElementById("channels-list");
      if (channelsList && currentStreams.length > 0) {
        const sorted = sortStreams([...currentStreams], sortMode);
        reorderChannels(channelsList, sorted, "user_id", (stream) => 
          stream.platform === "twitch" 
            ? createTwitchLiveCard(stream, stream.avatar_url)
            : createYoutubeLiveCard(stream, stream.avatar_url)
        );
        currentStreams = sorted;
      }
      filterStreams();
    });
  }

  const platformSelector = document.getElementById("platform-selector");
  if (platformSelector) {
    platformSelector.value = platformFilter;
    platformSelector.addEventListener("change", (event) => {
      platformFilter = event.target.value;
      localStorage.setItem('platformFilter', platformFilter);
      filterStreams();
    });
  }

  const searchLiveInput = document.getElementById("search-live");
  if (searchLiveInput) searchLiveInput.value = "";
  if (searchLiveInput) {
    searchLiveInput.addEventListener("input", (e) => {
      searchLiveQuery = e.target.value;
      filterStreams();
    });
  }

  // === UPCOMING TAB ===
  
  const searchUpcomingInput = document.getElementById("search-upcoming");
  if (searchUpcomingInput) searchUpcomingInput.value = "";
  if (searchUpcomingInput) {
    searchUpcomingInput.addEventListener("input", (e) => {
      searchUpcomingQuery = e.target.value;
      filterUpcomingStreams(searchUpcomingQuery);
    });
  }

  // === CHANNELS TAB ===
  const sortChannelsSelector = document.getElementById("sort-channels-selector");
  if (sortChannelsSelector) {
    sortChannelsSelector.value = sortChannelsMode; // ← restaure le visuel
    sortChannelsSelector.addEventListener("change", (event) => {
      sortChannelsMode = event.target.value;
      localStorage.setItem('sortChannelsMode', sortChannelsMode);
      displayChannels();
    });
  }

  const searchChannelsInput = document.getElementById("search-channels");
  if (searchChannelsInput) searchChannelsInput.value = "";
  if (searchChannelsInput) {
    searchChannelsInput.addEventListener("input", (e) => {
      searchChannelsQuery = e.target.value;
      filterChannels();
    });
  }

  // === NOTIFICATIONS TAB ===
  const searchNotificationsInput = document.getElementById("search-notifications");
  if (searchNotificationsInput) searchNotificationsInput.value = "";
  if (searchNotificationsInput) {
    searchNotificationsInput.addEventListener("input", (e) => {
      searchNotificationsQuery = e.target.value;
      filterNotifications();
    });
  }

  // Visibility change (durée des streams)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.getElementById("live")?.classList.contains("active")) {
      startDurationUpdates();
    } else {
      stopDurationUpdates();
    }
  });
});

async function getTwitchAccessToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("access_token");
  if (urlToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
    currentTwitchToken = urlToken;
    updateLogoutButtonVisibility();
    return urlToken;
  }

  if (!currentTwitchToken) {
    try {
      const response = await fetch("/get-token");
      const data = await response.json();
      if (data.access_token) {
        currentTwitchToken = data.access_token;
        updateLogoutButtonVisibility();
      }
    } catch (error) {
      console.error("Erreur lors de la récupération du jeton Twitch depuis le cookie :", error);
    }
  }

  return currentTwitchToken;
}

async function getYoutubeAccessToken() {
  if (!currentYoutubeToken) {
    try {
      const response = await fetch("/get-youtube-token");
      const data = await response.json();
      if (data.access_token) {
        currentYoutubeToken = data.access_token;
        updateLogoutButtonVisibility();
      }
    } catch (error) {
      console.error("Erreur lors de la récupération du jeton YouTube depuis le cookie :", error);
    }
  }

  return currentYoutubeToken;
}

async function refreshTwitchToken() {
  try {
    const response = await fetch("/refresh-token");
    if (!response.ok) {
      throw new Error("Échec de l'enregistrement du rafraîchissement du jeton Twitch");
    }
    const data = await response.json();
    if (!data.access_token) {
      currentTwitchToken = null;
      updateLogoutButtonVisibility();
      throw new Error("Échec de la récupération du jeton d'accès après le rafraîchissement");
    } else {
      currentTwitchToken = data.access_token;
      updateLogoutButtonVisibility();
      return data;
    }
  } catch (error) {
    console.error("Erreur lors du rafraîchissement du jeton Twitch :", error);
    currentTwitchToken = null;
    updateLogoutButtonVisibility();
    return null;
  }
}

async function getUserId(token) {
  try {
    const response = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        "Client-Id": clientId,
        Authorization: `Bearer ${token}`,
      },
    });
    if (response.status === 401) {
      const newToken = await refreshTwitchToken();
      if (!newToken) {
        throw new Error("Impossible de rafraîchir le jeton");
      }
      return await getUserId(newToken);
    }
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return await getUserId(token);
    }
    const data = await response.json();
    if (data.data && data.data[0]) {
      return data.data[0].id;
    } else {
      throw new Error("Aucun utilisateur trouvé : " + JSON.stringify(data));
    }
  } catch (error) {
    console.error("Erreur lors de la récupération de l'ID utilisateur :", error);
    displayError("Erreur lors de la récupération des informations utilisateur.", "channels-list");
    return null;
  }
}

async function getFollowedStreams() {
  console.log(`[${new Date().toISOString()}] Début de getFollowedStreams`);
  const token = await getTwitchAccessToken();
  const channelsList = document.getElementById("channels-list");
  if (!channelsList) {
    console.error("Element with ID 'channels-list' not found");
    return;
  }
  if (!token) {
    console.log("Aucun jeton Twitch, affichage du message d'erreur");   
    updateLogoutButtonVisibility();
    return;
  }

  try {
    const response = await fetch("/get-live-streams");
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Échec de la récupération des streams en direct");
    }
    const streams = await response.json();
    console.log(`[${new Date().toISOString()}] Streams récupérés via /get-live-streams:`, streams.length);

    if (streams.length > 0) {
      await updateChannels(streams, token);
    } else {
      console.log("Aucun stream en direct");
      displayError("Aucun stream suivi n'est actuellement en direct.", "channels-list");
      currentStreams = [];
      channelsList.innerHTML = "";
      stopDurationUpdates();
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la récupération des streams:`, error);
    displayError("Erreur lors du chargement des streams. Veuillez réessayer.", "channels-list");
    stopDurationUpdates();
  }
}

async function getFollowedChannels() {
  const token = await getTwitchAccessToken();
  const channelsList = document.getElementById("followed-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'followed-channels-list' not found");
    return;
  }
  if (!token) {
    console.log("Aucun jeton Twitch, affichage du message d'erreur");    
    updateLogoutButtonVisibility();
    return;
  }

  const userId = await getUserId(token);
  if (!userId) return;

  let allChannels = [];
  let cursor = null;

  try {
    do {
      const url = `https://api.twitch.tv/helix/channels/followed?user_id=${userId}&first=100${cursor ? `&after=${cursor}` : ""}`;
      const response = await fetch(url, {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401) {
        const newToken = await refreshTwitchToken();
        if (!newToken) {
          throw new Error("Impossible de rafraîchir le jeton");
        }
        return await getFollowedChannels();
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      const data = await response.json();

      if (data.data) {
        allChannels = allChannels.concat(data.data);
      }

      cursor = data.pagination?.cursor || null;
    } while (cursor);

    if (allChannels.length > 0) {
      const profiles = await getUserProfiles(allChannels.map((channel) => channel.broadcaster_id), token);
      const twitchChannels = allChannels.map(channel => ({
        platform: "twitch",
        id: channel.broadcaster_id,
        title: channel.broadcaster_name,
        thumbnail: profiles[channel.broadcaster_id],
        subscriptionDate: channel.followed_at,
        url: `https://www.twitch.tv/${channel.broadcaster_login.toLowerCase()}`
      }));
      currentFollowedChannels = twitchChannels;
      displayChannels();
    } else {
      displayError("Aucune chaîne suivie trouvée.", "followed-channels-list");
      currentFollowedChannels = [];
      channelsList.innerHTML = "";
    }
  } catch (error) {
    console.error("Erreur lors de la récupération des chaînes suivies :", error);
    displayError("Erreur lors du chargement des chaînes suivies. Veuillez vous reconnecter.", "followed-channels-list");
    currentTwitchToken = null;
    updateLogoutButtonVisibility();
  }
}

async function getYoutubeChannels() {
  const token = await getYoutubeAccessToken();
  const channelsList = document.getElementById("followed-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'followed-channels-list' not found");
    return;
  }
  if (!token) {
    console.log("Aucun jeton YouTube, affichage du message d'erreur");    
    updateLogoutButtonVisibility();
    return;
  }

  try {
    const response = await fetch("/get-youtube-channels");
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Échec de la récupération des chaînes YouTube");
    }
    const channels = await response.json();
    const youtubeChannels = channels.map(channel => ({
      platform: "youtube",
      id: channel.channelId,
      title: channel.title,
      thumbnail: channel.thumbnail,
      subscriptionDate: channel.subscriptionDate,
      url: `https://www.youtube.com/channel/${channel.channelId}`
    }));
    currentYoutubeChannels = youtubeChannels;
    displayChannels();
  } catch (error) {
    console.error("Erreur lors de la récupération des chaînes YouTube :", error);
    displayError("Erreur lors du chargement des chaînes YouTube. Veuillez vous reconnecter.", "followed-channels-list");
    currentYoutubeToken = null;
    updateLogoutButtonVisibility();
  }
}

async function getUserProfiles(userIds, token) {
  const cachedProfiles = {};
  const uncachedIds = userIds.filter((id) => !avatarCache.has(id));
  if (uncachedIds.length === 0) {
    return userIds.reduce((acc, id) => {
      acc[id] = avatarCache.get(id);
      return acc;
    }, {});
  }

  try {
    const batches = [];
    for (let i = 0; i < uncachedIds.length; i += 100) {
      batches.push(uncachedIds.slice(i, i + 100));
    }

    const profiles = {};
    for (const batch of batches) {
      const url = `https://api.twitch.tv/helix/users?${batch.map((id) => `id=${id}`).join("&")}`;
      const response = await fetch(url, {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401) {
        const newToken = await refreshTwitchToken();
        if (!newToken) {
          throw new Error("Impossible de rafraîchir le jeton");
        }
        return await getUserProfiles(userIds, newToken);
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return await getUserProfiles(userIds, token);
      }
      const data = await response.json();
      data.data.forEach((user) => {
        const url =
          user.profile_image_url ||
          "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png";
        profiles[user.id] = url;
        avatarCache.set(user.id, url);
      });
    }

    return userIds.reduce((acc, id) => {
      acc[id] =
        profiles[id] ||
        avatarCache.get(id) ||
        "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png";
      return acc;
    }, {});
  } catch (error) {
    console.error("Erreur lors de la récupération des profils :", error);
    return userIds.reduce((acc, id) => {
      acc[id] =
        avatarCache.get(id) ||
        "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png";
      return acc;
    }, {});
  }
}

async function getAutoLaunchSettings(userId) {
  try {
    const response = await fetch(`/get-autolaunch?userId=${userId}`);
    if (!response.ok) throw new Error("Échec récupération autolaunch");
    const data = await response.json();
    autoLaunchSettings = new Map(data.map(item => [`${item.platform}_${item.channelId}`, item.autoLaunchEnabled]));
    return autoLaunchSettings;
  } catch (error) {
    console.error("Erreur getAutoLaunchSettings:", error);
    return new Map();
  }
}

async function setAutoLaunchSetting(userId, platform, channelId, enabled) {
  try {
    const response = await fetch("/set-autolaunch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, platform, channelId, autoLaunchEnabled: enabled }),
    });
    if (!response.ok) throw new Error("Échec update autolaunch");
    autoLaunchSettings.set(`${platform}_${channelId}`, enabled);
    return true;
  } catch (error) {
    console.error("Erreur setAutoLaunchSetting:", error);
    return false;
  }
}

async function getNotificationSettings(userId) {
  try {
    const response = await fetch(`/get-notifications?userId=${userId}`);
    if (!response.ok) {
      throw new Error("Échec de la récupération des paramètres de notification");
    }
    const data = await response.json();
    notificationSettings = new Map(data.map((item) => [`${item.platform}_${item.channelId}`, item.notificationsEnabled]));
    return notificationSettings;
  } catch (error) {
    console.error("Erreur lors de la récupération des paramètres de notification :", error);
    return new Map();
  }
}

async function setNotificationSetting(userId, platform, channelId, enabled) {
  try {
    console.log(`[${new Date().toISOString()}] Envoi de la requête setNotificationSetting:`, { userId, platform, channelId, notificationsEnabled: enabled });
    const response = await fetch("/set-notification", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        platform,
        channelId,
        notificationsEnabled: enabled,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Échec de la mise à jour des paramètres de notification: ${response.status} ${response.statusText} - ${errorText}`);
    }
    const result = await response.json();
    if (!result.success) {
      throw new Error("Réponse serveur non réussie");
    }
    notificationSettings.set(`${platform}_${channelId}`, enabled);
    console.log(`[${new Date().toISOString()}] Notification mise à jour avec succès:`, { platform, channelId, enabled });

    if (enabled) {
      const stream = currentStreams.find((s) => s.user_id === channelId && s.platform === platform);
      if (stream) {
        console.log(`[${new Date().toISOString()}] Chaîne déjà en direct, déclenchement de l'alerte:`, stream);
        showNotification(stream);
      }
    }

    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Erreur lors de la mise à jour des paramètres de notification pour ${platform}_${channelId}:`, error.message);
    return false;
  }
}

function showNotificationError(message) {
  const notificationsContainer = document.getElementById("notifications");
  if (notificationsContainer) {
    const notification = document.createElement("div");
    notification.className = "notification";
    notification.innerHTML = `
      ${message}
      <span class="notification-close">✕</span>
    `;
    notificationsContainer.appendChild(notification);
    notification.querySelector(".notification-close").addEventListener("click", () => {
      notification.remove();
    });
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);
  }
}

function filterUpcomingStreams(query) {
  const nowSec = Date.now() / 1000;
  const filteredStreams = currentUpcomingStreams.filter(stream => {
    const startTime = parseInt(stream.startTime);
    if (startTime < nowSec - 3600) return false; // Masquer si dépassé depuis + d'1h
    return stream.chTitle.toLowerCase().includes(query.toLowerCase()) || stream.vidTitle.toLowerCase().includes(query.toLowerCase());
  });

  const channelsList = document.getElementById('upcoming-channels-list');
  if (!channelsList) return;

  channelsList.innerHTML = '';

  filteredStreams.forEach(stream => {
    const card = createUpcomingCard(stream);
    channelsList.appendChild(card);
  });

  // ✅ Force la mise à jour des compteurs après l'ajout au DOM
  setTimeout(updateAllUpcomingCountdowns, 150);
}

// Met à jour tous les compteurs Upcoming existants
function updateAllUpcomingCountdowns() {
  Object.keys(countdownTimers).forEach(elementId => {
    const countdownElement = document.getElementById(elementId);
    if (countdownElement) {
      // On force un update immédiat
      const timerFunc = countdownTimers[elementId];
      if (typeof timerFunc === 'function') {
        timerFunc(); 
      }
    }
  });
}

async function updateUpcomingStreams() {
  const token = await getYoutubeAccessToken();
  const channelsList = document.getElementById("upcoming-channels-list");
  
  if (!channelsList) {
    console.error("Element with ID 'upcoming-channels-list' not found");
    return;
  }
  if (!token) {
    console.log("Aucun jeton YouTube, affichage du message d'erreur");    
    updateLogoutButtonVisibility();
    return;
  }
  try {
    const response = await fetch("/get-youtube-videos");
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Échec de la récupération des vidéos à venir");
    }
    const videos = await response.json();
    const nowSec = Date.now() / 1000;
    currentUpcomingStreams = videos.filter(v => parseInt(v.startTime) >= nowSec - 3600);
    // Nettoyage + affichage des cartes
    channelsList.innerHTML = "";
    currentUpcomingStreams.forEach(stream => {
      const card = createUpcomingCard(stream);
      channelsList.appendChild(card);
    });
    // ✅ Force la mise à jour des compteurs après l'ajout au DOM
    setTimeout(updateAllUpcomingCountdowns, 150);
  } catch (error) {
    console.error("Erreur lors de la récupération des vidéos à venir :", error);
    displayError("Erreur lors du chargement des vidéos à venir. Veuillez vous reconnecter.", "upcoming-channels-list");
    currentYoutubeToken = null;
    updateLogoutButtonVisibility();
  }
}

async function getUpcomingVideos() {
  const token = await getYoutubeAccessToken();
  if (!token) {
    console.log("Aucun jeton YouTube disponible");
    updateLogoutButtonVisibility();
    return;
  }

  try {
    console.log(`[${new Date().toISOString()}] 🔄 Requête /get-youtube-videos (Upcoming)`);
    
    const response = await fetch("/get-youtube-videos");
    if (!response.ok) throw new Error("Fetch failed");

    const videos = await response.json();
    console.log(`[${new Date().toISOString()}] 🔄 YT Vid : ${videos.length} (upcoming + live)`);

    const nowSec = Date.now() / 1000;
    currentUpcomingStreams = videos.filter(v => parseInt(v.startTime) >= nowSec - 3600);

    // Mise à jour visuelle uniquement si l'onglet est actif
    if (document.getElementById("upcoming")?.classList.contains("active")) {
      updateUpcomingStreams();
    }

  } catch (error) {
    console.error("Erreur récupération vidéos upcoming :", error);
  }
}

function sortUpcomingStreams(streams, sortValue) {
  let sortedStreams = [...streams];
  if (sortValue === 'name') {
    sortedStreams.sort((a, b) => a.chTitle.localeCompare(b.chTitle));
  } else if (sortValue === 'date') {
    sortedStreams.sort((a, b) => parseInt(a.startTime) - parseInt(b.startTime));
  }
  return sortedStreams;
}

function createUpcomingCard(stream) {
  const now = Date.now() / 1000; // Temps actuel en secondes
  const startTime = parseInt(stream.startTime);
  const isLive = startTime <= now;
  const countdownId = `countdown-${stream._id}`; // ID unique basé sur MongoDB _id
  const bellId = `bell-${stream._id}`;
  const bellKey = `bell_${stream.chTitle}_${stream.startTime}`;
  const isBellActive = localStorage.getItem(bellKey) === 'true';
  const bellClass = isBellActive ? 'bell-button yellow' : 'bell-button';
  const containerClass = isLive ? 'red-border' : (isBellActive ? 'yellow-border' : '');

  const truncatedChannelName = truncateText(stream.chTitle, 25);
  const truncatedTitle = truncateText(stream.vidTitle, 80);
  const safeChTitle = stream.chTitle.replace(/"/g, '&quot;');
  const safeVidTitle = stream.vidTitle.replace(/"/g, '&quot;');

  const card = document.createElement("div");
  card.className = `item-container youtube-border ${containerClass}`;
  card.innerHTML = `
    <div class="header-row">
      <a href="${stream.chUrl}" target="_blank">
        <img src="${stream.chThumbnail}" alt="${safeChTitle}" class="channel-img">
      </a>
      <div class="upcoming-channel-info">
        <p class="upcoming-channel-title" title="${safeChTitle}">${truncatedChannelName}</p>
        <p class="upcoming-countdown">
          <span id="${countdownId}" class="text-blue-400 font-bold">${isLive ? 'Pending...' : ''}</span>
        </p>
      </div>
      </div>
    <div id="${bellId}" class="upcoming-bell ${isBellActive ? 'yellow' : ''}" onclick="toggleBellColor('${bellId}', '${safeChTitle}', '${stream.startTime}')">
      <svg viewBox="0 0 24 24">
        <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>
      </svg>
    </div>
    <a href="${stream.vidUrl}" target="_blank">
      <img src="${stream.vidThumbnail}" alt="${safeVidTitle}" class="thumbnail">
    </a>
    <p class="stream-title" title="${safeVidTitle}">${truncatedTitle}</p>
  `;
  if (!isLive) {
    createCountdown(stream.startTime, countdownId, stream.vidUrl, bellId);
  }
  return card;
}

function formatDate(timestamp) {
  const date = new Date(parseInt(timestamp) * 1000);
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  return date.toLocaleDateString('fr-FR', options).replace(',', '');
}

function createCountdown(timestamp, elementId, vidUrl, bellId) {
  const targetTime = parseInt(timestamp) * 1000;
  const countdownId = elementId;

  if (countdownTimers[countdownId]) {
    clearInterval(countdownTimers[countdownId]);
  }

  const updateCountdown = () => {
    const el = document.getElementById(countdownId);
    if (!el) return;

    const diff = targetTime - Date.now();

    // Affichage compteur
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    if (days > 0) {
      el.textContent = `${days}j ${hours}h ${minutes}min`;
    } else if (hours > 0) {
      el.textContent = `${hours}h ${minutes}min`;
    } else {
      el.textContent = `${minutes}min`;
    }

    // ====================== AUTO LAUNCH ======================
    const container = el.closest('.item-container');
    if (!container) return;

    const chTitle = container.querySelector('p.text-gray-300.font-bold')?.textContent.trim() || '';
    const bellKey = `bell_${chTitle}_${timestamp}`;
    const triggeredKey = `launched_${bellKey}`;     // Clé persistante

    const isBellActive = container.classList.contains('yellow-border');

    // Si déjà lancé → on ne fait plus rien
    if (localStorage.getItem(triggeredKey)) {
      // On désactive visuellement au cas où
      container.classList.remove('yellow-border');
      const bell = container.querySelector('.bell-button');
      if (bell) bell.classList.remove('yellow');
      return;
    }

    if (isBellActive && diff <= 3 * 60 * 1000 && diff > 0) {
      console.log(`[AUTO LAUNCH] Déclenchement → ${chTitle}`);

      autoLaunchVideo(vidUrl, chTitle);

      // Marque comme lancé (persiste même après rechargement)
      localStorage.setItem(triggeredKey, 'true');

      // Désactive visuellement la cloche
      container.classList.remove('yellow-border');
      const bell = container.querySelector('.bell-button');
      if (bell) bell.classList.remove('yellow');
    }
  };

  setTimeout(updateCountdown, 150);
  countdownTimers[countdownId] = setInterval(updateCountdown, 10000);
}

// Fonction Auto-Launch simple
function autoLaunchVideo(vidUrl, title) {
  console.log(`[AUTO LAUNCH] → ${title}`);

  new Audio('/sounds/Big-Boom.mp3').play().catch(() => {});

  window.open(vidUrl, '_blank');

  const notif = document.createElement("div");
  notif.className = "notification";
  notif.innerHTML = `
    <strong>✅ Auto-Launch :</strong> ${title}<br>
    Vidéo ouverte dans un nouvel onglet
    <span class="notification-close">✕</span>
  `;
  document.getElementById("notifications")?.appendChild(notif);

  setTimeout(() => notif.remove(), 8000);
}

function toggleBellColor(buttonId, chTitle, startTime) {
  const button = document.getElementById(buttonId);
  const itemContainer = button.closest('.item-container');
  const bellKey = `bell_${chTitle}_${startTime}`;
  const isActive = button.classList.toggle('yellow');
  localStorage.setItem(bellKey, isActive);
  if (!itemContainer.classList.contains('red-border')) {
    itemContainer.classList.toggle('yellow-border', isActive);
  }
  if (isActive) {    
    const notifSound = new Audio('/sounds/bell-Notif.mp3');
    notifSound.play().catch(e => console.error("Erreur lors de la lecture du son :", e.message));
  }
}

function formatStreamDuration(startedAt) {
  const startTime = new Date(startedAt).getTime();
  const now = Date.now();
  const secondsElapsed = Math.floor((now - startTime) / 1000);

  const hours = Math.floor(secondsElapsed / 3600);
  const minutes = Math.floor((secondsElapsed % 3600) / 60);
  const seconds = secondsElapsed % 60;

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function createNotificationCard(notification) {
  const truncatedTitle = truncateText(notification.title || '', 85);
  const truncatedChannelName = truncateText(notification.user_name || 'Utilisateur inconnu', 22);
  const safeTitle = (notification.title || '').replace(/"/g, '&quot;');
  const safeUserName = (notification.user_name || '').replace(/"/g, '&quot;');

  let link = "#";
  if (notification.platform === "youtube") {
    link = notification.vidUrl || notification.stream_url || "#";
  } else if (notification.platform === "twitch") {
    link = notification.stream_url || `https://www.twitch.tv/${notification.user_name?.toLowerCase()}`;
  } else if (notification.stream_url) {
    link = notification.stream_url;
  }

  const card = document.createElement("a");
  card.className = `item-container notification-card ${notification.platform}-border`;
  card.href = link;
  card.target = "_blank";
  card.setAttribute("data-notification-id", notification.id || "");

  const avatarUrl = notification.avatar_url || 
    'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png';

  const thumbnailUrl = notification.thumbnail_url || 
    (notification.platform === "twitch" 
      ? 'https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg' 
      : 'https://i.ytimg.com/vi/default.jpg');

  card.innerHTML = `
    <div class="header-row">
      <a href="${link}" target="_blank" style="position: relative;">
        <img src="${avatarUrl}" alt="${safeUserName}" class="channel-img">
      </a>
      <div class="channel-info">
        <p class="channel-title" title="${safeUserName}">${truncatedChannelName}</p>
        <p class="notification-timestamp">${formatTimestamp(notification.timestamp)}</p>
      </div>
    </div>
    <a href="${link}" target="_blank">
      <img src="${thumbnailUrl}" alt="${safeTitle}" class="thumbnail">
    </a>
    <p class="stream-title" title="${safeTitle}">${truncatedTitle}</p>
  `;

  return card;
}

function sortStreams(streams, mode) {
  console.log(`[${new Date().toISOString()}] Tri des streams avec mode:`, mode, "Données:", streams);
  return streams.sort((a, b) => {
    if (!a || !b) {
      console.error("Stream invalide détecté:", a, b);
      return 0;
    }
    if (mode === "viewers") {
      const aViewers = a.viewer_count || 0;
      const bViewers = b.viewer_count || 0;
      return bViewers - aViewers;
    } else if (mode === "name") {
      const aName = a.user_name || "";
      const bName = b.user_name || "";
      return aName.localeCompare(bName, "fr", { sensitivity: "base" });
    } else if (mode === "duration") {
      const aStart = a.started_at || 0;
      const bStart = b.started_at || 0;
      return bStart - aStart;
    }
    return 0;
  });
}

function sortChannels(channels, mode) {
  return channels.sort((a, b) => {
    if (mode === "name") {
      return a.title.localeCompare(b.title, "fr", { sensitivity: "base" });
    } else if (mode === "date") {
      return new Date(b.subscriptionDate || 0).getTime() - new Date(a.subscriptionDate || 0).getTime();
    }
    return 0;
  });
}

function reorderChannels(channelsList, sortedItems, key, createCardFunction) {
  if (!channelsList) return;
  console.log("Réorganisation des cartes avec:", sortedItems);
  channelsList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  sortedItems.forEach((item) => {
    if (item) {
      const card = createCardFunction(item);
      fragment.appendChild(card);
    } else {
      console.warn("Item invalide ignoré:", item);
    }
  });
  channelsList.appendChild(fragment);
}

function filterStreams() {
  const channelsList = document.getElementById("channels-list");
  if (!channelsList) {
    console.error("Element with ID 'channels-list' not found");
    return;
  }
  const cards = channelsList.querySelectorAll(".item-container");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title")?.getAttribute('title')?.toLowerCase() || '';
    const gameTitle   = card.querySelector(".game-title")?.getAttribute('title')?.toLowerCase() || '';
    const streamTitle = card.querySelector(".stream-title")?.getAttribute('title')?.toLowerCase() || '';
    const platform    = card.classList.contains('twitch-border') ? 'twitch' : 'youtube';
    const query = searchLiveQuery.toLowerCase();
    const matchesSearch = !searchLiveQuery ||
      channelName.includes(query) ||
      gameTitle.includes(query) ||
      streamTitle.includes(query);
    const matchesPlatform = platformFilter === 'all' || platform === platformFilter;
    card.style.display = matchesSearch && matchesPlatform ? "block" : "none";
  });
}

function filterChannels() {
  const channelsList = document.getElementById("followed-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'followed-channels-list' not found");
    return;
  }
  const cards = channelsList.querySelectorAll(".channel-card");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title")?.textContent.toLowerCase() || "";
    card.style.display = searchChannelsQuery && !channelName.includes(searchChannelsQuery.toLowerCase()) ? "none" : "flex";
  });
}

async function saveNotificationToServer(notification) {
  try {
    const response = await fetch("/save-notification-log", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notification),
    });
    if (!response.ok) {
      throw new Error("Échec de l'enregistrement de la notification sur le serveur");
    }
    console.log("Notification enregistrée avec succès sur le serveur");
  } catch (error) {
    console.error("Erreur lors de l'enregistrement de la notification:", error);
    showNotificationError("Échec de l'enregistrement de la notification");
  }
}

async function getNotificationLogFromServer() {
  try {
    const response = await fetch("/get-notification-log");
    if (!response.ok) {
      throw new Error("Échec de la récupération du journal des notifications");
    }
    const data = await response.json();
    notificationLog = data;
    if (document.getElementById("notification-tab")?.classList.contains("active")) {
      updateNotificationLog();
    }
  } catch (error) {
    console.error("Erreur lors de la récupération du journal des notifications:", error);
    showNotificationError("Échec de la récupération du journal des notifications");
  }
}

function filterNotifications() {
  const notificationList = document.getElementById("notification-log-list");
  const cards = notificationList.querySelectorAll(".notification-card");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title").textContent.toLowerCase();
    const streamTitle = card.querySelector(".stream-title").textContent.toLowerCase();
    card.style.display = searchNotificationsQuery && !channelName.includes(searchNotificationsQuery.toLowerCase()) && !streamTitle.includes(searchNotificationsQuery.toLowerCase()) ? "none" : "flex";
  });
}

function listenToNotifications() {
  console.log(`[${new Date().toISOString()}] Initialisation du flux SSE /notifications-stream`);
  let eventSource;

  const connectSSE = () => {
    console.log(`[${new Date().toISOString()}] Connexion au flux SSE /notifications-stream`);
    eventSource = new EventSource('/notifications-stream');

    eventSource.onopen = function() {
      console.log(`[${new Date().toISOString()}] Connexion SSE établie`);
      getNotificationLogFromServer(); // Recharger depuis le serveur
    };

    eventSource.onmessage = function(event) {
      if (event.data === ': ping') {
        console.log(`[${new Date().toISOString()}] Ping SSE reçu`);
        return;
      }

      try {
        const notification = JSON.parse(event.data);

        if (!notification.id || lastNotificationIds.has(notification.id)) {
          console.log(`[${new Date().toISOString()}] Notification ignorée (dupliquée):`, notification.id);
          return;
        }

        console.log(`[${new Date().toISOString()}] Nouvelle notification via SSE:`, notification.user_name);

        lastNotificationIds.add(notification.id);

        // Mise à jour visuelle immédiate si l'onglet est ouvert
        if (document.getElementById("notification-tab")?.classList.contains("active")) {
          const notificationList = document.getElementById("notification-log-list");
          if (notificationList) {
            const card = createNotificationCard(notification);
            notificationList.insertBefore(card, notificationList.firstChild);
            filterNotifications();
          }
        }

        // Appel à la nouvelle fonction (elle gère l'ajout dans notificationLog + notif volante)
        showNotification({
          id: notification.id,
          user_id: notification.user_id,
          user_name: notification.user_name,
          title: notification.title,
          avatar_url: notification.avatar_url,
          platform: notification.platform,
          stream_url: notification.stream_url || (notification.platform === 'youtube' ? notification.vidUrl : `https://www.twitch.tv/${notification.user_name?.toLowerCase()}`),
          timestamp: notification.timestamp
        });

        const alKey = `${notification.platform}_${notification.user_id}`;
        if (autoLaunchSettings.get(alKey)) {
          const url = notification.platform === 'youtube' 
            ? (notification.vidUrl || notification.stream_url)
            : `https://www.twitch.tv/${notification.user_name?.toLowerCase()}`;
          console.log(`[AutoLaunch] Ouverture → ${url}`);
          window.open(url, '_blank');
        }       

        // Nettoyage du Set pour éviter la mémoire infinie
        if (lastNotificationIds.size > 1000) {
          lastNotificationIds = new Set([...lastNotificationIds].slice(-1000));
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur traitement notification SSE:`, error.message);
      }
    };

    eventSource.onerror = function(error) {
      console.error(`[${new Date().toISOString()}] Erreur SSE, reconnexion dans 5s:`, error);
      eventSource.close();
      setTimeout(connectSSE, 5000);
    };
  };

  connectSSE();
  return eventSource;
}

// ====================== NOTIFICATIONS ======================

// Fonction principale à appeler partout
async function showNotification(stream) {
    console.log(`[${new Date().toISOString()}] Alerte pour:`, stream.user_name);

    displayNotificationHTML(stream);           // Toujours exécuté
    await trySendBrowserNotification(stream);  // Notification Windows seulement si autorisé
}

// Affiche la notif volante + ajoute à l'historique
function displayNotificationHTML(stream) {
    // 1. Notification volante en haut à droite
    try {
        const notificationsContainer = document.getElementById("notifications");
        if (notificationsContainer) {
            const htmlNotification = document.createElement("div");
            htmlNotification.className = "notification";

            htmlNotification.innerHTML = `
                <div class="avatar">
                    <img src="${stream.avatar_url || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png'}" 
                         alt="${stream.user_name}" 
                         class="channel-img">
                </div>
                <div class="notification-content">
                    ${stream.user_name} est en direct !<br>
                    <span class="stream-title">${truncateText(stream.title || '', 85)}</span>
                    <span class="notification-close">✕</span>
                </div>
            `;

            notificationsContainer.appendChild(htmlNotification);

            htmlNotification.querySelector(".notification-close").addEventListener("click", () => htmlNotification.remove());

            setTimeout(() => {
                if (htmlNotification.parentNode) htmlNotification.remove();
            }, 5000);
        }
    } catch (error) {
        console.error("Erreur affichage notification HTML :", error.message);
    }

    // 2. Ajout à l'historique de l'onglet "Notifications"
    try {
        if (!notificationLog) notificationLog = [];

        const normalized = {
            id: stream.id || `notif-${Date.now()}`,
            user_id: stream.user_id || stream.userId,
            user_name: stream.user_name,
            title: stream.title,
            avatar_url: stream.avatar_url,
            platform: stream.platform || 'unknown',
            vidUrl: stream.vidUrl || (stream.platform === 'youtube' ? stream.stream_url : null),
            stream_url: stream.stream_url || 
                        (stream.platform === 'youtube' ? (stream.vidUrl || stream.stream_url) : 
                        `https://www.twitch.tv/${stream.user_name?.toLowerCase()}`),
            timestamp: stream.timestamp || Date.now()
        };

        notificationLog.unshift(normalized);

        if (notificationLog.length > 1000) {
            notificationLog = notificationLog.slice(0, 1000);
        }

        if (document.getElementById("notification-tab")?.classList.contains("active")) {
            updateNotificationLog();
        }
    } catch (error) {
        console.error("Erreur ajout à notificationLog :", error.message);
    }
}

// Notification système (pop-up Windows)
async function trySendBrowserNotification(stream) {
    if (Notification.permission === "denied") return;

    if (Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
            console.warn("Permission de notification refusée");
            return;
        }
    }

    try {
    const settingKey = `${stream.platform}_${stream.user_id || stream.userId}`;
    const bellActive = notificationSettings.get(settingKey) || false;
    if (bellActive) {
        const audio = new Audio("/sounds/tsar-bell.mp3");
        audio.volume = 0.2;
        audio.play().catch(() => {});
    }

        const notification = new Notification(`[${stream.platform || 'Live'}] ${stream.user_name}`, {
            body: stream.title || "Stream en direct",
            icon: stream.avatar_url || "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png",
            tag: `stream-${stream.user_id || Date.now()}`,
        });

        notification.onclick = () => {
            const url = stream.stream_url || 
                       (stream.platform === 'youtube' ? stream.vidUrl : `https://www.twitch.tv/${stream.user_name.toLowerCase()}`);
            window.open(url, "_blank");
            notification.close();
        };
    } catch (error) {
        console.error("Erreur notification système :", error.message);
    }
}

function updateNotificationLog() {
  const notificationList = document.getElementById("notification-log-list");
  if (!notificationList) {
    console.error("Element with ID 'notification-log-list' not found");
    return;
  }
  console.log(`[${new Date().toISOString()}] Mise à jour de l'onglet Notifications avec ${notificationLog.length} notifications`);
  notificationList.innerHTML = "";

  if (notificationLog.length === 0) {
    displayError("Aucune notification disponible.", "notification-log-list");
    return;
  }

  const fragment = document.createDocumentFragment();
  notificationLog.forEach((notification) => {
    const card = createNotificationCard(notification);
    fragment.appendChild(card);
  });
  notificationList.appendChild(fragment);

  filterNotifications();
}

function updateDurationCounters(timestamp) {
  if (document.visibilityState !== "visible" || currentStreams.length === 0 || !document.getElementById("live")?.classList.contains("active")) {
    durationAnimationFrame = null;
    return;
  }

  if (timestamp - lastDurationUpdate < 1000) {
    durationAnimationFrame = requestAnimationFrame(updateDurationCounters);
    return;
  }

  lastDurationUpdate = timestamp;
  const channelsList = document.getElementById("channels-list");
  if (channelsList) {
    currentStreams.forEach((stream) => {
      const card = channelsList.querySelector(`[data-user-id="${stream.user_id}"]`);
      if (card) {
        const streamDuration = card.querySelector(".stream-duration");
        if (streamDuration) {
          streamDuration.textContent = formatStreamDuration(stream.started_at);
        }
      }
    });
  }

  durationAnimationFrame = requestAnimationFrame(updateDurationCounters);
}

function startDurationUpdates() {
  stopDurationUpdates();
  if (currentStreams.length > 0 && document.visibilityState === "visible" && document.getElementById("live")?.classList.contains("active")) {
    lastDurationUpdate = performance.now();
    durationAnimationFrame = requestAnimationFrame(updateDurationCounters);
  }
}

function stopDurationUpdates() {
  if (durationAnimationFrame) {
    cancelAnimationFrame(durationAnimationFrame);
    durationAnimationFrame = null;
  }
}

async function updateChannels(streams, token) {
  console.log(`[${new Date().toISOString()}] Début de updateChannels avec`, streams.length, "streams");
  const channelsList = document.getElementById("channels-list");
  if (!channelsList) {
    console.error("Element with ID 'channels-list' not found");
    return;
  }
  channelsList.innerHTML = '<div class="loader"></div>';

  const sortedStreams = sortStreams(streams, sortMode);

  reorderChannels(channelsList, sortedStreams, null, (stream) => {
    const avatarUrl = stream.avatar_url || "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png";

    if (stream.platform === "twitch") {
      const card = createTwitchLiveCard(stream, avatarUrl);
      card.setAttribute("data-user-id", stream.user_id);
      return card;
    } else {
      //console.log("Création de carte YouTube pour:", stream.user_id);
      const card = createYoutubeLiveCard(stream, avatarUrl);
      card.setAttribute("data-user-id", stream.user_id);
      return card;
    }
  });

  console.log(`[${new Date().toISOString()}] Cartes réorganisées, currentStreams:`, sortedStreams.length);
  currentStreams = sortedStreams;

  filterStreams();
  startDurationUpdates();
}

function truncateText(title, maxLenght) {
 return title.length > maxLenght ? title.substring(0, maxLenght-2) + "..." : title;
}

function createTwitchLiveCard(stream, avatarUrl) {
  const truncatedTitle = truncateText(stream.title, 85);
  const truncatedChannelName = truncateText(stream.user_name, 17);
  const truncatedGameName = truncateText(stream.game_name, 22);
  const safeTitle = (stream.title || '').replace(/"/g, '&quot;');
  const safeUserName = (stream.user_name || '').replace(/"/g, '&quot;');
  const safeGameName = (stream.game_name || '').replace(/"/g, '&quot;');
  const card = document.createElement("div");
  card.className = `item-container twitch-border`;
  card.setAttribute('data-user-id', stream.user_id);
  card.innerHTML = `
    <div class="header-row">
      <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
        <img src="${stream.avatar_url || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png'}" alt="${safeUserName}" class="channel-img">
      </a>
      <div class="channel-info">
        <p class="channel-title" title="${safeUserName}">${truncatedChannelName}</p>
        <p class="viewer-count">${formatViewers(stream.viewer_count)}</p>
        <p class="game-title" title="${safeGameName}">${truncatedGameName || ''}</p>
        <p class="stream-duration">Démarré il y a <span class="duration-time" data-started-at="${stream.started_at}"></span></p>
      </div>
    </div>
    <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
      <img src="${stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') : 'https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg'}" alt="${safeUserName} thumbnail" class="thumbnail">
    </a>
    <p class="stream-title" title="${safeTitle}">${truncatedTitle}</p>
  `;
  return card;
}

function createYoutubeLiveCard(stream, avatarUrl) {
  const truncatedTitle = truncateText(stream.title, 85);
  const truncatedChannelName = truncateText(stream.user_name, 17);
  const safeTitle = (stream.title || '').replace(/"/g, '&quot;');
  const safeUserName = (stream.user_name || '').replace(/"/g, '&quot;');
  const card = document.createElement("div");
  card.className = `item-container youtube-border`;
  card.setAttribute('data-user-id', stream.user_id);
  card.innerHTML = `
    <div class="header-row">
      <a href="${stream.stream_url}" target="_blank">
        <img src="${stream.avatar_url || 'https://yt3.ggpht.com/ytc/default-channel-img.jpg'}" alt="${safeUserName}" class="channel-img">
      </a>
      <div class="channel-info">
        <p class="channel-title" title="${safeUserName}">${truncatedChannelName}</p>
        <p class="viewer-count">${formatViewers(stream.viewer_count)}</p>
        <p class="game-title" title="">&nbsp;</p>
        <p class="stream-duration">Démarré il y a <span class="duration-time" data-started-at="${stream.started_at}"></span></p>
      </div>
    </div>
    <a href="${stream.stream_url}" target="_blank">
      <img src="${stream.thumbnail_url || 'https://i.ytimg.com/vi/default.jpg'}" alt="${safeTitle} thumbnail" class="thumbnail">
    </a>
    <p class="stream-title" title="${safeTitle}">${truncatedTitle}</p>
  `;
  return card;
}

function createChannelCard(channel) {
  const settingKey = `${channel.platform}_${channel.id}`;
  const notificationsEnabled = notificationSettings.get(settingKey) || false;
  const autoLaunchEnabled = autoLaunchSettings.get(settingKey) || false;

  const card = document.createElement("a");
  card.className = `channel-card ${channel.platform}-border ${notificationsEnabled ? "notifications-enabled" : ""}`;
  card.href = channel.url;
  card.target = "_blank";
  card.setAttribute("data-channel-id", channel.id);
  card.innerHTML = `
    <div class="avatar">
      <img src="${channel.thumbnail}" alt="${channel.title}">
    </div>
    <div class="card-content">
      <p class="channel-title">${channel.title}</p>
      ${channel.subscriptionDate ? `<p class="subscription-date">Suivi le : ${formatTimestamp(channel.subscriptionDate)}</p>` : ""}
    </div>
    <svg class="autolaunch-btn ${autoLaunchEnabled ? "active" : ""}" viewBox="0 0 24 24">
      <rect x="2" y="2" width="20" height="20" rx="3" ry="3" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M9 7v10l8-5z"/>
    </svg>
    <svg class="notification-bell ${notificationsEnabled ? "active" : ""}" viewBox="0 0 24 17">
      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
    </svg>
  `;

  // Cloche
  const bell = card.querySelector(".notification-bell");
  let isProcessingBell = false;
  bell.addEventListener("click", async (e) => {
    e.preventDefault();
    if (isProcessingBell) return;
    isProcessingBell = true;
    const userId = await getUserId(currentTwitchToken || currentYoutubeToken) || "youtube_user";
    if (!userId) { showNotificationError("Utilisateur non connecté."); isProcessingBell = false; return; }
    const currentState = notificationSettings.get(settingKey) || false;
    const newState = !currentState;
    card.classList.toggle("notifications-enabled", newState);
    bell.classList.toggle("active", newState);
    const success = await setNotificationSetting(userId, channel.platform, channel.id, newState);
    if (!success) {
      notificationSettings.set(settingKey, currentState);
      card.classList.toggle("notifications-enabled", currentState);
      bell.classList.toggle("active", currentState);
      showNotificationError("Échec de la mise à jour. Veuillez réessayer.");
    }
    isProcessingBell = false;
  });

  // AutoLaunch
  const autoBtn = card.querySelector(".autolaunch-btn");
  let isProcessingAuto = false;
  autoBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (isProcessingAuto) return;
    isProcessingAuto = true;
    const userId = await getUserId(currentTwitchToken || currentYoutubeToken) || "youtube_user";
    if (!userId) { showNotificationError("Utilisateur non connecté."); isProcessingAuto = false; return; }
    const currentState = autoLaunchSettings.get(settingKey) || false;
    const newState = !currentState;
    autoBtn.classList.toggle("active", newState);
    const success = await setAutoLaunchSetting(userId, channel.platform, channel.id, newState);
    if (!success) {
      autoLaunchSettings.set(settingKey, currentState);
      autoBtn.classList.toggle("active", currentState);
      showNotificationError("Échec de la mise à jour. Veuillez réessayer.");
    }
    isProcessingAuto = false;
  });

  return card;
}

async function displayChannels() {
  const channelsList = document.getElementById("followed-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'followed-channels-list' not found");
    return;
  }
  const allChannels = [...currentFollowedChannels, ...currentYoutubeChannels];
  if (allChannels.length === 0) return;
  const sortedChannels = sortChannels(allChannels, sortChannelsMode);
  reorderChannels(channelsList, sortedChannels, "id", (channel) => createChannelCard(channel));
  filterChannels();
}

async function init() {
  console.log("Initialisation de l'application");
  // Charger les paramètres de notification en premier pour s'assurer qu'ils sont disponibles
  const userId = await getUserId(await getTwitchAccessToken() || await getYoutubeAccessToken() || "youtube_user");
  if (userId) {
    await getAutoLaunchSettings(userId);   
    console.log('Paramètres autolaunch chargés:', Array.from(autoLaunchSettings.entries()));
    await getNotificationSettings(userId);    
    console.log('Paramètres de notification chargés:', Array.from(notificationSettings.entries()));
  } else {
    console.error("Impossible de récupérer l'ID utilisateur pour les notifications");
  }
    await Promise.all([
    getFollowedStreams(),
    getFollowedChannels(),
    getYoutubeChannels(),
    getNotificationLogFromServer(),
    getUpcomingVideos(),
  ]);
  // Initialiser le flux SSE pour les notifications
  listenToNotifications();
  updateSyncStatus();
  setInterval(getFollowedStreams, 60000);
  setInterval(getFollowedChannels, 60 * 60 * 1000);
  setInterval(getYoutubeChannels, 60 * 60 * 1000);
  setInterval(getUpcomingVideos, 60000);
  setInterval(updateSyncStatus, 60000);
}

init();
