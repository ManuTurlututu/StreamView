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
let searchLiveQuery = "";
let searchFollowQuery = "";
let searchYoutubeQuery = "";
let searchNotificationsQuery = "";
const avatarCache = new Map();
let notificationSettings = new Map();

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

function displayError(message, listId) {
  const channelsList = document.getElementById(listId);
  channelsList.innerHTML = `<p class="error">${message}</p>`;
  if (listId === "channels-list") {
    stopDurationUpdates();
  }
}

function updateLogoutButtonVisibility() {
  const logoutApiButton = document.getElementById("logout-api-button");
  logoutApiButton.style.display = currentTwitchToken || currentYoutubeToken ? "block" : "none";
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelector(".tab.active").classList.remove("active");
    document.querySelector(".tab-content.active").classList.remove("active");
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "live") {
      startDurationUpdates();
      filterStreams();
    } else if (tab.dataset.tab === "follow") {
      stopDurationUpdates();
      filterFollowedChannels();
    } else if (tab.dataset.tab === "ytsub") {
      stopDurationUpdates();
      filterYoutubeChannels();
    } else if (tab.dataset.tab === "notification-tab") {
      stopDurationUpdates();
      updateNotificationLog();
      filterNotifications();
    } else if (tab.dataset.tab === "settings") {
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
  const token = await getTwitchAccessToken();
  const loginButton = document.getElementById("login-button");
  if (!token) {
    console.log("Aucun jeton Twitch, affichage du bouton de connexion");
    loginButton.style.display = "block";
    document.getElementById("channels-list").innerHTML = "";
    updateLogoutButtonVisibility();
    return;
  }

  loginButton.style.display = "none";
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
        if (!newToken) {
          throw new Error("Impossible de rafraîchir le jeton");
        }
        return await getFollowedStreams();
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("Ratelimit-Reset") || "1", 10);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      const data = await response.json();

      if (data.data) {
        allStreams = allStreams.concat(data.data);
      }

      cursor = data.pagination?.cursor || null;
    } while (cursor);

    if (allStreams.length > 0) {
      await updateChannels(allStreams, token);
    } else {
      displayError("Aucun stream suivi n'est actuellement en direct.", "channels-list");
      currentStreams = [];
      document.getElementById("channels-list").innerHTML = "";
      stopDurationUpdates();
    }
  } catch (error) {
    console.error("Erreur lors de la récupération des streams suivis :", error);
    displayError("Erreur lors du chargement des streams suivis. Veuillez vous reconnecter.", "channels-list");
    loginButton.style.display = "block";
    currentTwitchToken = null;
    updateLogoutButtonVisibility();
    stopDurationUpdates();
  }
}

async function getFollowedChannels() {
  const token = await getTwitchAccessToken();
  const loginButton = document.getElementById("login-button");
  if (!token) {
    console.log("Aucun jeton Twitch, affichage du bouton de connexion");
    loginButton.style.display = "block";
    document.getElementById("followed-channels-list").innerHTML = "";
    updateLogoutButtonVisibility();
    return;
  }

  loginButton.style.display = "none";
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
      await updateFollowedChannels(allChannels, token, userId);
    } else {
      displayError("Aucune chaîne suivie trouvée.", "followed-channels-list");
      currentFollowedChannels = [];
      document.getElementById("followed-channels-list").innerHTML = "";
    }
  } catch (error) {
    console.error("Erreur lors de la récupération des chaînes suivies :", error);
    displayError("Erreur lors du chargement des chaînes suivies. Veuillez vous reconnecter.", "followed-channels-list");
    loginButton.style.display = "block";
    currentTwitchToken = null;
    updateLogoutButtonVisibility();
  }
}

async function getYoutubeChannels() {
  const token = await getYoutubeAccessToken();
  const loginButton = document.getElementById("youtube-login-button");
  if (!token) {
    console.log("Aucun jeton YouTube, affichage du bouton de connexion");
    loginButton.style.display = "block";
    document.getElementById("ytsub-channels-list").innerHTML = "";
    updateLogoutButtonVisibility();
    return;
  }

  loginButton.style.display = "none";
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
    displayError("Erreur lors du chargement des chaînes YouTube. Veuillez vous reconnecter.", "ytsub-channels-list");
    loginButton.style.display = "block";
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

async function setNotificationSetting(userId, broadcasterId, enabled) {
  try {
    console.log("Envoi de la requête setNotificationSetting:", { userId, broadcasterId, notificationsEnabled: enabled });
    const response = await fetch("/set-notification", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId,
        broadcasterId,
        notificationsEnabled: enabled,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Échec de la mise à jour des paramètres de notification: ${response.status} ${response.statusText} - ${errorText}`);
    }
    notificationSettings.set(broadcasterId, enabled);
    console.log("Notification mise à jour avec succès:", { broadcasterId, enabled });

    if (enabled) {
      const stream = currentStreams.find((s) => s.user_id === broadcasterId);
      if (stream) {
        console.log("Chaîne déjà en direct, déclenchement de l'alerte:", stream);
        showNotification(stream);
      }
    }

    return true;
  } catch (error) {
    console.error("Erreur lors de la mise à jour des paramètres de notification :", error);
    showNotificationError(`Impossible de mettre à jour les notifications: ${error.message}`);
    return false;
  }
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

function createChannelCard(stream, avatarUrl) {
  const truncatedTitle = truncateTitle(stream.title);
  const card = document.createElement("a");
  card.className = "side-nav-card";
  card.href = `https://www.twitch.tv/${stream.user_name.toLowerCase()}`;
  card.target = "_blank";
  card.setAttribute("data-user-id", stream.user_id);
  card.innerHTML = `
          <div class="avatar">
              <img src="${avatarUrl}" alt="${stream.user_name}">
          </div>
          <div class="card-content">
              <p class="channel-title">${stream.user_name}</p>
              <p class="stream-title" title="${stream.title || "Aucun titre"}">${truncatedTitle}</p>
              <p class="game-title">${stream.game_name || "Inconnu"}</p>
              <p class="stream-duration">${formatStreamDuration(stream.started_at)}</p>
              <div class="live-status">
                  <span class="status-indicator"></span>
                  Live
                  <span class="viewer-count">${formatViewers(stream.viewer_count)} spectateurs</span>
              </div>
          </div>
      `;
  return card;
}

function createFollowedChannelCard(channel, avatarUrl, notificationsEnabled) {
  const card = document.createElement("a");
  card.className = `follow-card ${notificationsEnabled ? "notifications-enabled" : ""}`;
  card.href = `https://www.twitch.tv/${channel.broadcaster_login.toLowerCase()}`;
  card.target = "_blank";
  card.setAttribute("data-broadcaster-id", channel.broadcaster_id);
  card.innerHTML = `
          <div class="avatar">
              <img src="${avatarUrl}" alt="${channel.broadcaster_name}">
          </div>
          <div class="card-content">
              <p class="channel-title">${channel.broadcaster_name}</p>
              <p class="subscription-date">Suivi le : ${formatTimestamp(channel.followed_at)}</p>
          </div>
          <svg class="notification-bell ${notificationsEnabled ? "active" : ""}" viewBox="0 0 24 17">
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
      `;
  const bell = card.querySelector(".notification-bell");
  bell.addEventListener("click", async (e) => {
    e.preventDefault();
    const userId = await getUserId(currentTwitchToken);
    if (!userId) {
      showNotificationError("Utilisateur non connecté. Veuillez vous reconnecter.");
      return;
    }
    const currentState = notificationSettings.get(channel.broadcaster_id) || false;
    const newState = !currentState;
    console.log("Tentative de basculement de la cloche:", { broadcasterId: channel.broadcaster_id, currentState, newState });
    const success = await setNotificationSetting(userId, channel.broadcaster_id, newState);
    if (success) {
      card.classList.toggle("notifications-enabled", newState);
      bell.classList.toggle("active", newState);
    }
  });
  return card;
}

function createYoutubeChannelCard(channel) {
  const card = document.createElement("a");
  card.className = "yt-sub-card";
  card.href = `https://www.youtube.com/channel/${channel.channelId}`;
  card.target = "_blank";
  card.setAttribute("data-channel-id", channel.channelId);
  card.innerHTML = `
          <div class="avatar">
              <img src="${channel.thumbnail}" alt="${channel.title}">
            </div>
            <div class="card-content">
              <p class="channel-title">${channel.title}</p>
              ${channel.subscriptionDate ? `<p class="subscription-date">Abonné le : ${formatTimestamp(channel.subscriptionDate)}</p>` : ""}
            </div>
        `;
  return card;
}

function createNotificationCard(notification) {
  const truncatedTitle = truncateTitle(notification.title);
  const card = document.createElement("a");
  card.className = "notification-card";
  card.href = `https://www.twitch.tv/${notification.user_name.toLowerCase()}`;
  card.target = "_blank";
  card.setAttribute("data-notification-id", notification.id);
  card.innerHTML = `
          <div class="avatar">
              <img src="${notification.avatar_url}" alt="${notification.user_name}">
          </div>
          <div class="card-content">
              <p class="channel-title">${notification.user_name}</p>
              <p class="stream-title" title="${notification.title || "Aucun titre"}">${truncatedTitle}</p>
              <p class="notification-timestamp">${formatTimestamp(notification.timestamp)}</p>
          </div>
      `;
  return card;
}

function sortStreams(streams, mode) {
  console.log("Tri des streams avec mode:", mode, "Données :", streams);
  return streams.sort((a, b) => {
    if (!a || !b) {
      console.error("Stream invalide détecté:", a, b);
      return 0;
    }
    if (mode === "viewers") {
      return (b.viewer_count || 0) - (a.viewer_count || 0);
    } else if (mode === "name") {
      return (a.user_name || "").localeCompare(b.user_name || "", "fr", { sensitivity: "base" });
    } else if (mode === "duration") {
      return new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime();
    }
    return 0;
  });
}

function sortFollowedChannels(channels, mode) {
  console.log("Tri des chaînes suivies avec mode:", mode, "Données:", channels);
  return channels.sort((a, b) => {
    if (!a || !b) {
      console.error("Chaîne suivie invalide détectée:", a, b);
      return 0;
    }
    if (mode === "name") {
      return (a.broadcaster_name || "").localeCompare(b.broadcaster_name || "", "fr", { sensitivity: "base" });
    } else if (mode === "date") {
      return new Date(b.followed_at || 0).getTime() - new Date(a.followed_at || 0).getTime();
    }
    return 0;
  });
}

function sortYoutubeChannels(channels, mode) {
  console.log("Tri des chaînes YouTube avec mode:", mode, "Données:", channels);
  return channels.sort((a, b) => {
    if (!a || !b) {
      console.error("Chaîne YouTube invalide détectée:", a, b);
      return 0;
    }
    if (mode === "name") {
      return (a.title || "").localeCompare(b.title || "", "fr", { sensitivity: "base" });
    } else if (mode === "date") {
      return new Date(b.subscriptionDate || 0).getTime() - new Date(a.subscriptionDate || 0).getTime();
    }
    return 0;
  });
}

function reorderChannels(channelsList, sortedItems, key, createCardFunction) {
  console.log("Réorganisation des cartes avec:", sortedItems);
  channelsList.innerHTML = "";
  const fragment = document.createDocumentFragment();
  sortedItems.forEach((item) => {
    if (item && item[key]) {
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
  const cards = channelsList.querySelectorAll(".side-nav-card");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title").textContent.toLowerCase();
    card.style.display = searchLiveQuery && !channelName.includes(searchLiveQuery.toLowerCase()) ? "none" : "flex";
  });
}

function filterFollowedChannels() {
  const channelsList = document.getElementById("followed-channels-list");
  const cards = channelsList.querySelectorAll(".follow-card");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title").textContent.toLowerCase();
    card.style.display = searchFollowQuery && !channelName.includes(searchFollowQuery.toLowerCase()) ? "none" : "flex";
  });
}

function filterYoutubeChannels() {
  const channelsList = document.getElementById("ytsub-channels-list");
  const cards = channelsList.querySelectorAll(".yt-sub-card");
  cards.forEach((card) => {
    const channelName = card.querySelector(".channel-title").textContent.toLowerCase();
    card.style.display = searchYoutubeQuery && !channelName.includes(searchYoutubeQuery.toLowerCase()) ? "none" : "flex";
  });
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
    if (document.getElementById("notification-tab").classList.contains("active")) {
      updateNotificationLog();
    }
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
      
      // Ajouter la notification à notificationLog
      notificationLog.unshift(newNotification);
      
      // Mettre à jour l'onglet notifications si actif
      if (document.getElementById("notification-tab").classList.contains("active")) {
        updateNotificationLog();
      }
    } catch (error) {
      console.error("Erreur lors du traitement de la notification SSE:", error);
    }
  };

  eventSource.onerror = function(error) {
    console.error("Erreur SSE:", error);
    eventSource.close();
    // Réessayer après 5 secondes
    setTimeout(listenToNotifications, 5000);
  };
}

async function showNotification(stream) {
  console.log("showNotification appelée avec:", stream);

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

  await saveNotificationToServer(notification);

  try {
    console.log("Tentative de lecture du son");
    const audio = new Audio("https://cdn.glitch.global/381e5d8d-b90c-44f3-b3a2-2b1638838939/tsar-bell.mp3?v=1747811101504");
    audio.volume = 0.2;
    audio.play().catch((error) => console.error("Erreur lors de la lecture du son :", error));

    console.log("Vérification de la permission de notification:", Notification.permission);
    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      console.log("Résultat de la demande de permission:", permission);
      if (permission !== "granted") {
        console.warn("Permission de notification refusée");
        return;
      }
    }

    const avatarUrl =
      avatarCache.get(stream.user_id) ||
      "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png";
    console.log("Avatar utilisé pour la notification:", avatarUrl);

    const truncatedTitle = truncateTitle(stream.title);
    const notificationBody = `${truncatedTitle}\n${stream.game_name || "Inconnu"}`;
    console.log("Création de la notification système avec:", notificationBody);
    const notification = new Notification(stream.user_name, {
      body: notificationBody,
      icon: avatarUrl,
      requireInteraction: true,
      tag: `twitch-stream-${stream.user_id}`,
    });

    notification.onclick = () => {
      console.log("Notification cliquée, ouverture du stream");
      window.open(`https://www.twitch.tv/${stream.user_name.toLowerCase()}`, "_blank");
      notification.close();
    };

    console.log("Création de la notification HTML");
    const notificationsContainer = document.getElementById("notifications");
    const htmlNotification = document.createElement("div");
    htmlNotification.className = "notification";
    htmlNotification.innerHTML = `
              ${stream.user_name} est en direct !<br>
              <span class="stream-title">${truncatedTitle}</span>
              <span class="notification-close">✕</span>
          `;
    notificationsContainer.appendChild(htmlNotification);
    htmlNotification.querySelector(".notification-close").addEventListener("click", () => {
      console.log("Notification HTML fermée");
      htmlNotification.remove();
    });
    setTimeout(() => {
      if (htmlNotification.parentNode) {
        console.log("Notification HTML supprimée après timeout");
        htmlNotification.remove();
      }
    }, 5000);
  } catch (error) {
    console.error("Erreur dans showNotification:", error);
  }
}

function updateNotificationLog() {
  const notificationList = document.getElementById("notification-log-list");
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
  if (document.visibilityState !== "visible" || currentStreams.length === 0 || !document.getElementById("live").classList.contains("active")) {
    durationAnimationFrame = null;
    return;
  }

  if (timestamp - lastDurationUpdate < 1000) {
    durationAnimationFrame = requestAnimationFrame(updateDurationCounters);
    return;
  }

  lastDurationUpdate = timestamp;
  const channelsList = document.getElementById("channels-list");
  currentStreams.forEach((stream) => {
    const card = channelsList.querySelector(`[data-user-id="${stream.user_id}"]`);
    if (card) {
      const streamDuration = card.querySelector(".stream-duration");
      streamDuration.textContent = formatStreamDuration(stream.started_at);
    }
  });

  durationAnimationFrame = requestAnimationFrame(updateDurationCounters);
}

function startDurationUpdates() {
  stopDurationUpdates();
  if (currentStreams.length > 0 && document.visibilityState === "visible" && document.getElementById("live").classList.contains("active")) {
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

async function updateChannels(newStreams, token) {
  const channelsList = document.getElementById("channels-list");
  channelsList.innerHTML = '<div class="loader"></div>';
  const currentStreamIds = currentStreams.map((stream) => stream.user_id);
  const newStreamIds = newStreams.map((stream) => stream.user_id);

  const newLiveStreams = newStreams.filter((stream) => !currentStreamIds.includes(stream.user_id));
  newLiveStreams.forEach((stream) => {
    if (notificationSettings.get(stream.user_id)) {
      showNotification(stream);
    }
  });

  const profiles = await getUserProfiles(newStreamIds, token);

  const sortedStreams = sortStreams([...newStreams], sortMode);

  reorderChannels(channelsList, sortedStreams, "user_id", (stream) =>
    createChannelCard(
      stream,
      profiles[stream.user_id] ||
        "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png"
    )
  );

  currentStreams = sortedStreams;

  filterStreams();
  startDurationUpdates();
}

async function updateFollowedChannels(newChannels, token, userId) {
  const channelsList = document.getElementById("followed-channels-list");
  channelsList.innerHTML = '<div class="loader"></div>';

  await getNotificationSettings(userId);

  const profiles = await getUserProfiles(newChannels.map((channel) => channel.broadcaster_id), token);

  const sortedChannels = sortFollowedChannels([...newChannels], sortFollowMode);

  reorderChannels(channelsList, sortedChannels, "broadcaster_id", (channel) =>
    createFollowedChannelCard(
      channel,
      profiles[channel.broadcaster_id] ||
        "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png",
      notificationSettings.get(channel.broadcaster_id) || false
    )
  );

  currentFollowedChannels = sortedChannels;

  filterFollowedChannels();
}

function updateYoutubeChannels() {
  const channelsList = document.getElementById("ytsub-channels-list");
  channelsList.innerHTML = '<div class="loader"></div>';

  if (currentYoutubeChannels.length === 0) {
    displayError("Aucune chaîne YouTube abonnée trouvée.", "ytsub-channels-list");
    return;
  }

  const sortedChannels = sortYoutubeChannels([...currentYoutubeChannels], sortYoutubeMode);
  reorderChannels(channelsList, sortedChannels, "channelId", (channel) => createYoutubeChannelCard(channel));

  currentYoutubeChannels = sortedChannels;

  filterYoutubeChannels();
}

document.getElementById("sort-selector").addEventListener("change", (event) => {
  console.log("Sort selector changed to:", event.target.value);
  sortMode = event.target.value;
  if (currentStreams.length > 0) {
    const sortedStreams = sortStreams([...currentStreams], sortMode);
    const channelsList = document.getElementById("channels-list");
    reorderChannels(channelsList, sortedStreams, "user_id", (stream) =>
      createChannelCard(
        stream,
        avatarCache.get(stream.user_id) ||
          "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png"
      )
    );
    currentStreams = sortedStreams;
    filterStreams();
  } else {
    console.log("Aucun stream à trier");
  }
});

document.getElementById("sort-follow-selector").addEventListener("change", (event) => {
  console.log("Sort follow selector changed to:", event.target.value);
  sortFollowMode = event.target.value;
  if (currentFollowedChannels.length > 0) {
    const sortedChannels = sortFollowedChannels([...currentFollowedChannels], sortFollowMode);
    const channelsList = document.getElementById("followed-channels-list");
    reorderChannels(channelsList, sortedChannels, "broadcaster_id", (channel) =>
      createFollowedChannelCard(
        channel,
        avatarCache.get(channel.broadcaster_id) ||
          "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png",
        notificationSettings.get(channel.broadcaster_id) || false
      )
    );
    currentFollowedChannels = sortedChannels;
    filterFollowedChannels();
  } else {
    console.log("Aucune chaîne suivie à trier");
  }
});

document.getElementById("sort-ytsub-selector").addEventListener("change", (event) => {
  console.log("Sort ytsub selector changed to:", event.target.value);
  sortYoutubeMode = event.target.value;
  if (currentYoutubeChannels.length > 0) {
    const sortedChannels = sortYoutubeChannels([...currentYoutubeChannels], sortYoutubeMode);
    const channelsList = document.getElementById("ytsub-channels-list");
    reorderChannels(channelsList, sortedChannels, "channelId", (channel) => createYoutubeChannelCard(channel));
    currentYoutubeChannels = sortedChannels;
    filterYoutubeChannels();
  } else {
    console.log("Aucune chaîne YouTube à trier");
  }
});

document.getElementById("search-live").addEventListener("input", (event) => {
  searchLiveQuery = event.target.value;
  filterStreams();
});

document.getElementById("search-follow").addEventListener("input", (event) => {
  searchFollowQuery = event.target.value;
  filterFollowedChannels();
});

document.getElementById("search-ytsub").addEventListener("input", (event) => {
  searchYoutubeQuery = event.target.value;
  filterYoutubeChannels();
});

document.getElementById("search-notifications").addEventListener("input", (event) => {
  searchNotificationsQuery = event.target.value;
  filterNotifications();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && document.getElementById("live").classList.contains("active")) {
    startDurationUpdates();
  } else {
    stopDurationUpdates();
  }
});

async function init() {
  await Promise.all([getFollowedStreams(), getFollowedChannels(), getYoutubeChannels(), getNotificationLogFromServer()]);
  setInterval(getFollowedStreams, 60000);
  setInterval(getFollowedChannels, 60 * 60 * 1000);
  setInterval(getYoutubeChannels, 60 * 60 * 1000);
  listenToNotifications(); // Ajouter l'écouteur SSE pour les notifications
}

init();