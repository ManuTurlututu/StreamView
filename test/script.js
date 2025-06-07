const clientId = "fwff5k4xwotxh84zfgo3hla684twde";
let currentTwitchToken = null;
let currentYoutubeToken = null;
let currentStreams = [];
let currentFollowedChannels = [];
let currentYoutubeChannels = [];
let notificationLog = [];
let sortMode = "viewers";
let sortFollowMode = "name";
let sortYoutubeMode = "name";
let durationAnimationFrame = null;
let lastDurationUpdate = 0;
let searchQuery = "";
const avatarCache = new Map();
let notificationSettings = new Map();

// Objet pour stocker les IDs des intervalles de compte à rebours
const countdownTimers = {};

// Tableau pour stocker les notifications actives
const activeNotifications = [];

// Fonctions utilitaires
function truncateTitle(title) {
  if (!title) return "Aucun titre";
  return title.length > 85 ? title.substring(0, 85) + "..." : title;
}

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

function formatDate(timestamp) {
  const date = new Date(parseInt(timestamp) * 1000);
  const options = { weekday: 'short', day: 'numeric', month: 'short' };
  return date.toLocaleDateString('fr-FR', options).replace(',', '');
}

function displayError(message, listId) {
  const container = document.getElementById(listId);
  container.innerHTML = `<p class="error">${message}</p>`;
}

// Fonctions de gestion des tokens et utilisateur
async function getTwitchAccessToken() {
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get("access_token");
  if (urlToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
    currentTwitchToken = urlToken;
    return urlToken;
  }

  if (!currentTwitchToken) {
    try {
      const response = await fetch("/get-token");
      const data = await response.json();
      if (data.access_token) {
        currentTwitchToken = data.access_token;
      }
    } catch (error) {
      console.error("Erreur lors de la récupération du jeton Twitch :", error);
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
      }
    } catch (error) {
      console.error("Erreur lors de la récupération du jeton YouTube :", error);
    }
  }

  return currentYoutubeToken;
}

async function refreshTwitchToken() {
  try {
    const response = await fetch("/refresh-token");
    if (!response.ok) {
      throw new Error("Échec du rafraîchissement du jeton Twitch");
    }
    const data = await response.json();
    if (!data.access_token) {
      currentTwitchToken = null;
      throw new Error("Échec de la récupération du jeton d'accès");
    } else {
      currentTwitchToken = data.access_token;
      return data;
    }
  } catch (error) {
    console.error("Erreur lors du rafraîchissement du jeton Twitch :", error);
    currentTwitchToken = null;
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
      throw new Error("Aucun utilisateur trouvé");
    }
  } catch (error) {
    console.error("Erreur lors de la récupération de l'ID utilisateur :", error);
    return null;
  }
}

// Fonctions de récupération des données
async function getFollowedStreams() {
  const token = await getTwitchAccessToken();
  if (!token) return;

  const userId = await getUserId(token);
  if (!userId) return;

  let allStreams = [];
  let cursor = null;

  try {
    do {
      const url = `https://api.twitch.tv/helix/streams/followed?user_id=${userId}&first=100${cursor ? `&after=${cursor}` : ""}`;
      const response = await fetch(url, {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.status === 401) {
        const newToken = await refreshTwitchToken();
        if (!newToken) throw new Error("Impossible de rafraîchir le jeton");
        return await getFollowedStreams();
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      const data = await response.json();
      if (data.data) allStreams = allStreams.concat(data.data);
      cursor = data.pagination?.cursor || null;
    } while (cursor);

    if (allStreams.length > 0) {
      await updateChannels(allStreams, token);
    } else {
      displayError("Aucun stream suivi n'est en direct.", "live-items");
      currentStreams = [];
    }
  } catch (error) {
    console.error("Erreur lors de la récupération des streams :", error);
    displayError("Erreur lors du chargement des streams.", "live-items");
  }
}

async function getFollowedChannels() {
  const token = await getTwitchAccessToken();
  if (!token) return;

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
        if (!newToken) throw new Error("Impossible de rafraîchir le jeton");
        return await getFollowedChannels();
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      const data = await response.json();
      if (data.data) allChannels = allChannels.concat(data.data);
      cursor = data.pagination?.cursor || null;
    } while (cursor);

    if (allChannels.length > 0) {
      await updateFollowedChannels(allChannels, token, userId);
    } else {
      displayError("Aucune chaîne suivie trouvée.", "sub-ch-items");
      currentFollowedChannels = [];
    }
  } catch (error) {
    console.error("Erreur lors de la récupération des chaînes :", error);
    displayError("Erreur lors du chargement des chaînes.", "sub-ch-items");
  }
}

async function getYoutubeChannels() {
  const token = await getYoutubeAccessToken();
  if (!token) return;

  try {
    const response = await fetch("/get-youtube-channels");
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Échec de la récupération des chaînes YouTube");
    }
    const channels = await response.json();
    currentYoutubeChannels = channels;
    updateYoutubeChannels();
  } catch (error) {
    console.error("Erreur lors de la récupération des chaînes YouTube :", error);
    displayError("Erreur lors du chargement des chaînes YouTube.", "sub-ch-items");
  }
}

// Fonctions de mise à jour des onglets
async function updateChannels(streams, token) {
  const liveItemsDiv = document.getElementById("live-items");
  liveItemsDiv.innerHTML = '<div class="loader"></div>';

  const profiles = await getUserProfiles(streams.map((stream) => stream.user_id), token);

  streams.forEach((stream) => {
    const itemContainer = document.createElement("div");
    itemContainer.className = "item-container";
    itemContainer.innerHTML = `
      <div class="header-row">
        <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
          <img src="${profiles[stream.user_id] || "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png"}" alt="${stream.user_name}" class="channel-img">
        </a>
        <div class="schedule-info">
          <p class="text-gray-300 font-bold">Live</p>
        </div>
      </div>
      <p class="text-gray-300 font-bold">${stream.user_name}</p>
      <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
        <img src="${stream.thumbnail_url.replace("{width}", "300").replace("{height}", "169")}" alt="${stream.title}" class="thumbnail mb-2">
      </a>
      <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank" class="text-gray-300 hover:text-blue-400">${truncateTitle(stream.title)}</a>
    `;
    liveItemsDiv.appendChild(itemContainer);
  });

  currentStreams = streams;
}

async function updateFollowedChannels(channels, token, userId) {
  const subChItemsDiv = document.getElementById("sub-ch-items");
  subChItemsDiv.innerHTML = '<div class="loader"></div>';

  await getNotificationSettings(userId);

  const profiles = await getUserProfiles(channels.map((channel) => channel.broadcaster_id), token);

  channels.forEach((channel, index) => {
    const bookmarkId = `bookmark-${index}`;
    const bookmarkKey = `bookmark_${encodeURIComponent(channel.broadcaster_login)}`;
    const isBookmarkActive = localStorage.getItem(bookmarkKey) === 'true';
    const bookmarkClass = isBookmarkActive ? 'bookmark-button orange' : 'bookmark-button';
    const containerClass = isBookmarkActive ? 'item-container yellow-border' : 'item-container';

    const itemContainer = document.createElement("div");
    itemContainer.className = containerClass;
    itemContainer.innerHTML = `
      <div class="header-row">
        <a href="https://www.twitch.tv/${channel.broadcaster_login.toLowerCase()}" target="_blank">
          <img src="${profiles[channel.broadcaster_id] || "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png"}" alt="${channel.broadcaster_name}" class="channel-img">
        </a>
        <div class="schedule-info">
          <div id="${bookmarkId}" class="${bookmarkClass}" onclick="toggleBookmarkColor('${bookmarkId}', '${channel.broadcaster_login}')">
            <svg viewBox="0 0 24 24">
              <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="text-gray-300 font-bold">${channel.broadcaster_name}</p>
    `;
    subChItemsDiv.appendChild(itemContainer);
  });

  currentFollowedChannels = channels;
}

function updateYoutubeChannels() {
  const subChItemsDiv = document.getElementById("sub-ch-items");
  subChItemsDiv.innerHTML = '<div class="loader"></div>';

  if (currentYoutubeChannels.length === 0) {
    displayError("Aucune chaîne YouTube abonnée trouvée.", "sub-ch-items");
    return;
  }

  currentYoutubeChannels.forEach((channel) => {
    const itemContainer = document.createElement("div");
    itemContainer.className = "item-container";
    itemContainer.innerHTML = `
      <div class="header-row">
        <a href="https://www.youtube.com/channel/${channel.channelId}" target="_blank">
          <img src="${channel.thumbnail}" alt="${channel.title}" class="channel-img">
        </a>
      </div>
      <p class="text-gray-300 font-bold">${channel.title}</p>
    `;
    subChItemsDiv.appendChild(itemContainer);
  });
}

// Fonctions de gestion des notifications
function showNotification(stream) {
  const notificationId = Date.now().toString();
  const notification = {
    id: notificationId,
    user_id: stream.user_id,
    user_name: stream.user_name,
    title: stream.title || "Aucun titre",
    avatar_url:
      avatarCache.get(stream.user_id) ||
      "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png",
    timestamp: Date.now(),
  };

  // Sauvegarder la notification sur le serveur
  saveNotificationToServer(notification);

  // Créer la notification HTML
  const notificationsContainer = document.getElementById("notifications");
  const htmlNotification = document.createElement("div");
  htmlNotification.className = "notification";
  htmlNotification.innerHTML = `
    <div class="flex flex-col">
      <img src="${notification.avatar_url}" alt="${notification.user_name}" class="self-center">
    </div>
    <div class="flex flex-col ml-3">
      <p class="text-base font-bold text-white">${notification.user_name}</p>
      <div class="flex flex-row items-center">
        <span class="text-sm text-gray-300 mr-2">${formatTimestamp(notification.timestamp)}</span>
        <span class="text-sm font-bold text-red-500">Live</span>
      </div>
    </div>
    <div class="close-button" onclick="closeNotification(this)">
      <svg viewBox="0 0 24 24">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
    </div>
  `;

  notificationsContainer.appendChild(htmlNotification);
  activeNotifications.push(htmlNotification);
  updateNotificationPositions();
  setTimeout(() => htmlNotification.classList.add('show'), 100);
  setTimeout(() => {
    if (htmlNotification.parentNode) {
      htmlNotification.classList.remove('show');
      setTimeout(() => htmlNotification.remove(), 300);
    }
  }, 5000);
}

function closeNotification(button) {
  const notification = button.closest('.notification');
  if (notification) {
    notification.classList.remove('show');
    setTimeout(() => {
      const index = activeNotifications.indexOf(notification);
      if (index !== -1) {
        activeNotifications.splice(index, 1);
        notification.remove();
        updateNotificationPositions();
      }
    }, 300);
  }
}

function updateNotificationPositions() {
  const baseBottom = 20;
  const spacing = 10;
  const notificationHeight = 90;

  activeNotifications.forEach((notification, index) => {
    const bottom = baseBottom + (activeNotifications.length - 1 - index) * (notificationHeight + spacing);
    notification.style.bottom = `${bottom}px`;
    notification.style.zIndex = 1000 - index;
  });
}

// Fonctions de gestion des cloches et marque-pages
function toggleBellColor(buttonId, chTitle, startTime) {
  const button = document.getElementById(buttonId);
  const itemContainer = button.closest('.item-container');
  const notifSound = new Audio('Sound/bell-Notif.mp3');
  notifSound.preload = 'auto';
  button.classList.toggle('yellow');
  if (button.classList.contains('yellow')) {
    notifSound.play().catch(e => console.error("Erreur lors de la lecture du son :", e.message));
  }
  if (!itemContainer.classList.contains('red-border')) {
    itemContainer.classList.toggle('yellow-border');
  }
  const bellKey = `bell_${chTitle}_${startTime}`;
  localStorage.setItem(bellKey, button.classList.contains('yellow'));
}

function toggleBookmarkColor(buttonId, chUrl) {
  const button = document.getElementById(buttonId);
  const itemContainer = button.closest('.item-container');
  const notifSound = new Audio('Sound/bell-Notif.mp3');
  notifSound.preload = 'auto';
  button.classList.toggle('orange');
  if (button.classList.contains('orange')) {
    notifSound.play().catch(e => console.error("Erreur lors de la lecture du son :", e.message));
  }
  itemContainer.classList.toggle('yellow-border');
  const bookmarkKey = `bookmark_${encodeURIComponent(chUrl)}`;
  localStorage.setItem(bookmarkKey, button.classList.contains('orange'));
}

// Fonctions de tri et filtrage
function sortStreams(streams, mode) {
  return streams.sort((a, b) => {
    if (mode === "viewers") return (b.viewer_count || 0) - (a.viewer_count || 0);
    if (mode === "name") return (a.user_name || "").localeCompare(b.user_name || "");
    if (mode === "duration") return new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime();
    return 0;
  });
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

async function getNotificationSettings(userId) {
  try {
    const response = await fetch(`/get-notifications?userId=${userId}`);
    if (!response.ok) {
      throw new Error("Échec de la récupération des paramètres de notification");
    }
    const data = await response.json();
    notificationSettings = new Map(data.map((item) => [item.broadcasterId, item.notificationsEnabled]));
    return notificationSettings;
  } catch (error) {
    console.error("Erreur lors de la récupération des paramètres de notification :", error);
    return new Map();
  }
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
  } catch (error) {
    console.error("Erreur lors de la récupération du journal des notifications:", error);
    showNotificationError("Échec de la récupération du journal des notifications");
  }
}

function listenToNotifications() {
  const eventSource = new EventSource('/notifications-stream');

  eventSource.onmessage = function(event) {
    try {
      const newNotification = JSON.parse(event.data);
      console.log("Nouvelle notification reçue via SSE:", newNotification);
      
      notificationLog.unshift(newNotification);
      showNotification(newNotification);
    } catch (error) {
      console.error("Erreur lors du traitement de la notification SSE:", error);
    }
  };

  eventSource.onerror = function(error) {
    console.error("Erreur SSE:", error);
    eventSource.close();
    setTimeout(listenToNotifications, 5000);
  };
}

function showNotificationError(message) {
  const notificationsContainer = document.getElementById("notifications");
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

// Écouteurs d'événements
document.addEventListener("DOMContentLoaded", () => {
  init();
});

// Fonction d'initialisation
async function init() {
  await Promise.all([getFollowedStreams(), getFollowedChannels(), getYoutubeChannels(), getNotificationLogFromServer()]);
  setInterval(getFollowedStreams, 60000);
  setInterval(getFollowedChannels, 60 * 60 * 1000);
  setInterval(getYoutubeChannels, 60 * 60 * 1000);
  listenToNotifications();
}
