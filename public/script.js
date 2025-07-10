const clientId = "fwff5k4xwotxh84zfgo3hla684twde";
const countdownTimers = {};
const avatarCache = new Map();

let currentTwitchToken = null;
let currentYoutubeToken = null;
let currentStreams = [];
let currentFollowedChannels = [];
let currentYoutubeChannels = [];
let notificationLog = [];
let sortMode = "viewers";
let sortChannelsMode = "date"; // Added to fix ReferenceError
let sortUpcomingMode = "date";
let durationAnimationFrame = null;
let lastDurationUpdate = 0;
let searchLiveQuery = "";
let searchChannelsQuery = ""; // Added to replace searchFollowQuery and searchYoutubeQuery
let searchNotificationsQuery = "";
let searchUpcomingQuery = "";
let notificationSettings = new Map();
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
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelector(".tab.active")?.classList.remove("active");
      document.querySelector(".tab-content.active")?.classList.remove("active");
      tab.classList.add("active");
      const tabContent = document.getElementById(tab.dataset.tab);
      if (!tabContent) {
        console.error(`Tab content for ${tab.dataset.tab} not found`);
        return;
      }
      tabContent.classList.add("active");
      if (tab.dataset.tab === "live") {
        startDurationUpdates();
        filterStreams();
      } else if (tab.dataset.tab === "channels") {
        stopDurationUpdates();
        displayChannels();
      } else if (tab.dataset.tab === "notification-tab") {
        stopDurationUpdates();
        console.log(`[${new Date().toISOString()}] Onglet Notifications activé, mise à jour en cours`);
        getNotificationLogFromServer(); // Recharger les notifications pour s'assurer qu'elles sont à jour
        updateNotificationLog();
        filterNotifications();
      } else if (tab.dataset.tab === "settings") {
        stopDurationUpdates();
        updateLogoutButtonVisibility();
      } else if (tab.dataset.tab === "upcoming") {
        stopDurationUpdates();
        filterUpcomingStreams(searchUpcomingQuery);
      }
    });
  });

  // Live tab: Sort and search
  const sortSelector = document.getElementById("sort-selector");
  if (sortSelector) {
    sortSelector.addEventListener("change", (event) => {
      console.log("Sort selector changed to:", event.target.value);
      sortMode = event.target.value;
      if (currentStreams.length > 0) {
        const sortedStreams = sortStreams([...currentStreams], sortMode);
        const channelsList = document.getElementById("channels-list");
        if (channelsList) {
          reorderChannels(channelsList, sortedStreams, "user_id", (stream) =>
            createTwitchLiveCard(
              stream,
              avatarCache.get(stream.user_id) ||
                "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png"
            )
          );
          currentStreams = sortedStreams;
          filterStreams();
        } else {
          console.error("Element with ID 'channels-list' not found");
        }
      } else {
        console.log("Aucun stream à trier");
      }
    });
  } else {
    console.error("Element with ID 'sort-selector' not found");
  }

  const searchLiveInput = document.getElementById("search-live");
  if (searchLiveInput) {
    searchLiveInput.addEventListener("input", (event) => {
      searchLiveQuery = event.target.value;
      filterStreams();
    });
  } else {
    console.error("Element with ID 'search-live' not found");
  }

  // Upcoming tab: Sort and search
  const sortUpcomingSelector = document.getElementById("sort-upcoming-selector");
  if (sortUpcomingSelector) {
    sortUpcomingSelector.addEventListener("change", (event) => {
      console.log("Sort upcoming selector changed to:", event.target.value);
      sortUpcomingMode = event.target.value;
      if (currentUpcomingStreams.length > 0) {
        const sortedStreams = sortUpcomingStreams([...currentUpcomingStreams], sortUpcomingMode);
        const channelsList = document.getElementById("upcoming-channels-list");
        if (channelsList) {
          reorderChannels(channelsList, sortedStreams, "vidUrl", (stream) => createUpcomingCard(stream));
          currentUpcomingStreams = sortedStreams;
          filterUpcomingStreams(searchUpcomingQuery);
        } else {
          console.error("Element with ID 'upcoming-channels-list' not found");
        }
      } else {
        console.log("Aucun stream à venir à trier");
      }
    });
  } else {
    console.error("Element with ID 'sort-upcoming-selector' not found");
  }

  const searchUpcomingInput = document.getElementById("search-upcoming");
  if (searchUpcomingInput) {
    searchUpcomingInput.addEventListener("input", (event) => {
      searchUpcomingQuery = event.target.value;
      filterUpcomingStreams(searchUpcomingQuery);
    });
  } else {
    console.error("Element with ID 'search-upcoming' not found");
  }

  // Channels tab: Sort and search
  const sortChannelsSelector = document.getElementById("sort-channels-selector");
  if (sortChannelsSelector) {
    sortChannelsSelector.addEventListener("change", (event) => {
      console.log("Sort channels selector changed to:", event.target.value);
      sortChannelsMode = event.target.value;
      displayChannels();
    });
  } else {
    console.error("Element with ID 'sort-channels-selector' not found");
  }

  const searchChannelsInput = document.getElementById("search-channels");
  if (searchChannelsInput) {
    searchChannelsInput.addEventListener("input", (event) => {
      searchChannelsQuery = event.target.value;
      filterChannels();
    });
  } else {
    console.error("Element with ID 'search-channels' not found");
  }

  // Notifications tab: Search
  const searchNotificationsInput = document.getElementById("search-notifications");
  if (searchNotificationsInput) {
    searchNotificationsInput.addEventListener("input", (event) => {
      searchNotificationsQuery = event.target.value;
      filterNotifications();
    });
  } else {
    console.error("Element with ID 'search-notifications' not found");
  }

  // Visibility change for duration updates
  document.addEventListener("visibilitychange", () => {
    const liveTab = document.getElementById("live");
    if (document.visibilityState === "visible" && liveTab?.classList.contains("active")) {
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
    channelsList.innerHTML = "";
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
    channelsList.innerHTML = "";
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
    channelsList.innerHTML = "";
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
  const filteredStreams = currentUpcomingStreams.filter(stream =>
    stream.chTitle.toLowerCase().includes(query.toLowerCase()) || stream.vidTitle.toLowerCase().includes(query.toLowerCase())
  );
  const channelsList = document.getElementById('upcoming-channels-list');
  if (channelsList) {
    channelsList.innerHTML = '';
    filteredStreams.forEach(stream => {
      const card = createUpcomingCard(stream);
      channelsList.appendChild(card);
    });
  }
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
    channelsList.innerHTML = "";
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
    currentUpcomingStreams = videos;
    channelsList.innerHTML = "";
    videos.forEach(stream => {
      const card = createUpcomingCard(stream);
      channelsList.appendChild(card);
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des vidéos à venir :", error);
    displayError("Erreur lors du chargement des vidéos à venir. Veuillez vous reconnecter.", "upcoming-channels-list");
    currentYoutubeToken = null;
    updateLogoutButtonVisibility();
  }
}

async function getUpcomingVideos() {
  const token = await getYoutubeAccessToken();
  const channelsList = document.getElementById("upcoming-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'upcoming-channels-list' not found");
    return;
  }
  if (!token) {
    console.log("Aucun jeton YouTube, affichage du message d'erreur");
    channelsList.innerHTML = "";
    updateLogoutButtonVisibility();
    return;
  }

  try {
    console.log("Récupération des vidéos YouTube via /get-youtube-videos");
    const response = await fetch("/get-youtube-videos");
    if (!response.ok) {
      const errorData = await response.json();
      console.error("Échec de /get-youtube-videos:", errorData);
      throw new Error(errorData.error || "Échec de la récupération des vidéos à venir");
    }
    const videos = await response.json();
    console.log("Vidéos YouTube récupérées:", videos.length, "vidéos");
    //console.log("Exemple de vidéo:", videos[0] || "Aucune vidéo");
    console.log("Statuts uniques:", [...new Set(videos.map(stream => stream.status || "undefined"))]);
    currentUpcomingStreams = videos;
    console.log("currentUpcomingStreams mis à jour:", currentUpcomingStreams.length, "vidéos");
    updateUpcomingStreams();
  } catch (error) {
    console.error("Erreur lors de la récupération des vidéos à venir :", error);
    displayError("Erreur lors du chargement des vidéos à venir. Veuillez vous reconnecter.", "upcoming-channels-list");
    currentYoutubeToken = null;
    updateLogoutButtonVisibility();
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

  const card = document.createElement("div");
  card.className = `item-container ${containerClass}`;
  card.innerHTML = `
    <div class="header-row">
      <a href="${stream.chUrl}" target="_blank">
        <img src="${stream.chThumbnail}" alt="${stream.chTitle}" class="channel-img">
      </a>
      <div class="schedule-info">
        <p class="text-gray-300 font-bold">${formatDate(stream.startTime)}</p>
        <p id="${countdownId}" class="text-blue-400 font-bold">${isLive ? 'Pending...' : ''}</p>
        <div id="${bellId}" class="${bellClass}" onclick="toggleBellColor('${bellId}', '${stream.chTitle}', '${stream.startTime}')">
          <svg viewBox="0 0 24 24">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>
          </svg>
        </div>
      </div>
    </div>
    <p class="text-gray-300 font-bold">${stream.chTitle}</p>
    <a href="${stream.vidUrl}" target="_blank">
      <img src="${stream.vidThumbnail}" alt="${stream.vidTitle}" class="thumbnail mb-2">
    </a>
    <a href="${stream.vidUrl}" target="_blank" class="text-gray-300 hover:text-blue-400">${stream.vidTitle}</a>
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
  let hasOpened = false;

  const updateCountdown = () => {
    const now = Date.now();
    const distance = targetTime - now;
    const countdownElement = document.getElementById(elementId);
    const itemContainer = countdownElement ? countdownElement.closest('.item-container') : null;
    const bellButton = document.getElementById(bellId);

    if (!countdownElement || !itemContainer || !bellButton) {
      clearInterval(countdownTimers[elementId]);
      delete countdownTimers[elementId];
      return;
    }

    if (distance < 0) {
      countdownElement.innerHTML = 'Live';
      countdownElement.classList.remove('text-blue-400');
      countdownElement.classList.add('text-red-500');
      itemContainer.classList.remove('yellow-border');
      itemContainer.classList.add('red-border');
      bellButton.style.display = 'none';
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((distance % (1000 * 60)) / 1000);

    countdownElement.innerHTML = `${days}j ${hours}h ${minutes}m ${seconds}s`;
    countdownElement.classList.remove('text-red-500');
    countdownElement.classList.add('text-blue-400');
    itemContainer.classList.remove('red-border');
    bellButton.style.display = 'flex';

    const totalSeconds = Math.floor(distance / 1000);
    if (totalSeconds <= 5 * 60 && bellButton.classList.contains('yellow') && !hasOpened) {
      window.open(vidUrl, '_blank');
      const alertSound = new Audio('/sounds/tsar-bell.mp3');
      alertSound.volume = 0.15;
      alertSound.play().catch(e => console.error("Erreur lors de la lecture du son :", e.message));
      hasOpened = true;
    }
  };

  updateCountdown();
  countdownTimers[elementId] = setInterval(updateCountdown, 1000);
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
  const truncatedTitle = truncateText(notification.title, 85);
  const card = document.createElement("a");
  card.className = "notification-card";
  card.href = notification.stream_url || `https://www.twitch.tv/${notification.user_name.toLowerCase()}`;
  card.target = "_blank";
  card.setAttribute("data-notification-id", notification.id);
  card.innerHTML = `
    <div class="avatar">
      <img src="${notification.avatar_url}" alt="${notification.user_name}">
    </div>
    <div class="card-content">
      <p class="channel-title">${notification.user_name}</p>
      <p class="stream-title" title="${notification.title || 'Aucun titre'}">${truncatedTitle}</p>
      <p class="notification-timestamp">${formatTimestamp(notification.timestamp)}</p>
    </div>
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
    card.style.display = searchLiveQuery && !channelName.includes(searchLiveQuery.toLowerCase()) ? "none" : "block";
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
      // Recharger les notifications récentes pour s'assurer que rien n'a été manqué
      getNotificationLogFromServer();
    };

    eventSource.onmessage = function(event) {
      if (event.data === ': ping') {
        console.log(`[${new Date().toISOString()}] Ping SSE reçu`);
        return;
      }

      try {
        const notification = JSON.parse(event.data);
        if (!notification.id || lastNotificationIds.has(notification.id)) {
          console.log(`[${new Date().toISOString()}] Notification ignorée (dupliquée ou invalide):`, notification.id);
          return;
        }

        console.log(`[${new Date().toISOString()}] Nouvelle notification via SSE:`, {
          id: notification.id,
          user_name: notification.user_name,
          title: notification.title,
          platform: notification.platform,
          timestamp: notification.timestamp
        });
        lastNotificationIds.add(notification.id);

        // Ajouter la notification à notificationLog
        notificationLog.unshift(notification);
        if (notificationLog.length > 1000) {
          notificationLog = notificationLog.slice(0, 1000);
        }

        // Mettre à jour l'onglet Notifications si actif
        if (document.getElementById("notification-tab")?.classList.contains("active")) {
          console.log(`[${new Date().toISOString()}] Mise à jour de l'onglet Notifications avec nouvelle notification`);
          const notificationList = document.getElementById("notification-log-list");
          if (notificationList) {
            const card = createNotificationCard(notification);
            notificationList.insertBefore(card, notificationList.firstChild);
            filterNotifications();
          } else {
            console.error(`[${new Date().toISOString()}] Element notification-log-list introuvable`);
          }
        }

        // Afficher la notification pop-up
        showNotification({
          user_id: notification.user_id,
          user_name: notification.user_name,
          title: notification.title,
          avatar_url: notification.avatar_url,
          game_name: "Inconnu",
          started_at: notification.timestamp,
          stream_url: notification.platform === 'youtube' ? notification.vidUrl : `https://www.twitch.tv/${notification.user_name.toLowerCase()}`,
        });

        if (lastNotificationIds.size > 1000) {
          lastNotificationIds = new Set([...lastNotificationIds].slice(-1000));
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Erreur lors du traitement de la notification SSE:`, error.message, error);
      }
    };

    eventSource.onerror = function(error) {
      console.error(`[${new Date().toISOString()}] Erreur SSE, reconnexion dans 5 secondes:`, error);
      eventSource.close();
      setTimeout(connectSSE, 5000);
    };
  };

  connectSSE();
  return eventSource;
}

async function showNotification(stream) {
  console.log(`[${new Date().toISOString()}] Alerte pour:`, stream.user_name);

  try {
    const audio = new Audio("/sounds/tsar-bell.mp3");
    audio.volume = 0.2;
    audio.play().catch(e => console.error("Erreur son:", e.message));

    if (Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        console.warn("Permission de notification refusée");
        return;
      }
    }

    const notification = new Notification(stream.user_name, {
      body: `${truncateText(stream.title, 85)}\n${stream.game_name || "Inconnu"}`,
      icon: stream.avatar_url || "https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png",
      tag: `stream-${stream.user_id}`,
    });

    notification.onclick = () => {
      window.open(stream.stream_url || `https://www.twitch.tv/${stream.user_name.toLowerCase()}`, "_blank");
      notification.close();
    };

    const notificationsContainer = document.getElementById("notifications");
    if (notificationsContainer) {
      const htmlNotification = document.createElement("div");
      htmlNotification.className = "notification";
      htmlNotification.innerHTML = `
        <div class="avatar">
          <img src="${stream.avatar_url || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png'}" alt="${stream.user_name}" class="channel-img">
        </div>
        <div class="notification-content">
          ${stream.user_name} est en direct !<br>
          <span class="stream-title">${truncateText(stream.title, 85)}</span>
          <span class="notification-close">✕</span>
        </div>
      `;
      notificationsContainer.appendChild(htmlNotification);
      htmlNotification.querySelector(".notification-close").addEventListener("click", () => htmlNotification.remove());
      setTimeout(() => htmlNotification.parentNode && htmlNotification.remove(), 5000);
    }
  } catch (error) {
    console.error("Erreur alerte:", error.message);
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
  const card = document.createElement("div");
  card.className = `item-container twitch-border`;
  card.setAttribute('data-user-id', stream.user_id);
  card.innerHTML = `
    <div class="header-row">
      <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
        <img src="${stream.avatar_url || 'https://static-cdn.jtvnw.net/user-default-pictures-uv/ead5c8b2-5b63-11e9-846d-3629493f349c-profile_image-70x70.png'}" alt="${stream.user_name}" class="channel-img">
      </a>
      <div class="channel-info">
        <p class="channel-title" title="${stream.user_name}">${truncatedChannelName}</p>
        <p class="viewer-count">${formatViewers(stream.viewer_count)}</p>
        <p class="game-title" title="${stream.game_name || ''}">${truncatedGameName || ''}</p>
        <p class="stream-duration">Démarré il y a <span class="duration-time" data-started-at="${stream.started_at}"></span></p>
      </div>
    </div>
    <a href="https://www.twitch.tv/${stream.user_name.toLowerCase()}" target="_blank">
      <img src="${stream.thumbnail_url ? stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720') : 'https://static-cdn.jtvnw.net/ttv-static/404_preview-1280x720.jpg'}" alt="${stream.user_name} thumbnail" class="thumbnail">
    </a>
    <p class="stream-title" title="${stream.title || 'Aucun titre'}">${truncatedTitle}</p>
  `;
  return card;
}

function createYoutubeLiveCard(stream, avatarUrl) {
  const truncatedTitle = truncateText(stream.title, 85);
  const truncatedChannelName = truncateText(stream.user_name, 17);
  const card = document.createElement("div");
  card.className = `item-container youtube-border`;
  card.setAttribute('data-user-id', stream.user_id);
  card.innerHTML = `
    <div class="header-row">
      <a href="${stream.stream_url}" target="_blank">
        <img src="${stream.avatar_url || 'https://yt3.ggpht.com/ytc/default-channel-img.jpg'}" alt="${stream.user_name}" class="channel-img">
      </a>
      <div class="channel-info">
        <p class="channel-title" title="${stream.user_name}">${truncatedChannelName}</p>
        <p class="viewer-count">${formatViewers(stream.viewer_count)}</p>
        <p class="game-title" title="">&nbsp;</p>
        <p class="stream-duration">Démarré il y a <span class="duration-time" data-started-at="${stream.started_at}"></span></p>
      </div>
    </div>
    <a href="${stream.stream_url}" target="_blank">
      <img src="${stream.thumbnail_url || 'https://i.ytimg.com/vi/default.jpg'}" alt="${stream.title} thumbnail" class="thumbnail">
    </a>
    <p class="stream-title" title="${stream.title || 'Aucun titre'}">${truncatedTitle}</p>
  `;
  return card;
}

function createChannelCard(channel) {
  const settingKey = `${channel.platform}_${channel.id}`;
  const notificationsEnabled = notificationSettings.get(settingKey) || false;
  //console.log(`Création de la carte pour la chaîne ${channel.id} (${channel.platform}), notifications activées: ${notificationsEnabled}`); // Log de débogage
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
    <svg class="notification-bell ${notificationsEnabled ? "active" : ""}" viewBox="0 0 24 17">
      <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
    </svg>
  `;

  const bell = card.querySelector(".notification-bell");
  let isProcessing = false; // Empêcher les clics multiples
  bell.addEventListener("click", async (e) => {
    e.preventDefault();
    if (isProcessing) return; // Ignorer si une requête est en cours
    isProcessing = true;

    const userId = await getUserId(currentTwitchToken || currentYoutubeToken) || "youtube_user";
    if (!userId) {
      showNotificationError("Utilisateur non connecté. Veuillez vous reconnecter.");
      isProcessing = false;
      return;
    }

    const currentState = notificationSettings.get(settingKey) || false;
    const newState = !currentState;

    // Mise à jour optimiste de l'UI
    card.classList.toggle("notifications-enabled", newState);
    bell.classList.toggle("active", newState);
    console.log(`[${new Date().toISOString()}] Clic sur la cloche: ${settingKey} -> ${newState}`);

    const success = await setNotificationSetting(userId, channel.platform, channel.id, newState);
    if (!success) {
      // Revertir l'état en cas d'échec
      notificationSettings.set(settingKey, currentState);
      card.classList.toggle("notifications-enabled", currentState);
      bell.classList.toggle("active", currentState);
      showNotificationError("Échec de la mise à jour de la notification. Veuillez réessayer.");
    }

    isProcessing = false;
  });

  return card;
}

async function displayChannels() {
  const channelsList = document.getElementById("followed-channels-list");
  if (!channelsList) {
    console.error("Element with ID 'followed-channels-list' not found");
    return;
  }
  channelsList.innerHTML = '<div class="loader"></div>';

  const allChannels = [...currentFollowedChannels, ...currentYoutubeChannels];
  const sortedChannels = sortChannels(allChannels, sortChannelsMode);

  reorderChannels(channelsList, sortedChannels, "id", (channel) => createChannelCard(channel));

  filterChannels();
}

async function init() {
  console.log("Initialisation de l'application");
  // Charger les paramètres de notification en premier pour s'assurer qu'ils sont disponibles
  const userId = await getUserId(await getTwitchAccessToken() || await getYoutubeAccessToken() || "youtube_user");
  if (userId) {
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
  setInterval(getFollowedStreams, 60000);
  setInterval(getFollowedChannels, 60 * 60 * 1000);
  setInterval(getYoutubeChannels, 60 * 60 * 1000);
  setInterval(getUpcomingVideos, 60000);
}

init();