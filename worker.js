const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";
const ADMIN_ID = 5527067319;
const BOT_USERNAME = "@InstantMP3SongBot";

// Fast in-memory cache + persistent fallback
const SONG_CACHE = new Map();
const MEM_USERS = new Set([ADMIN_ID]);
const MEM_STATS = {
  searches: 0,
  downloads: 0,
  joinedAt: new Date().toISOString().slice(0, 10)
};
let ADMIN_BROADCAST_MODE = false;

export default {
  async fetch(request, env) {
    const botToken = (env && env.BOT_TOKEN ? env.BOT_TOKEN : DEFAULT_BOT_TOKEN).trim();
    const geminiKey = (env && env.GEMINI_KEY ? env.GEMINI_KEY : DEFAULT_GEMINI_KEY).trim();
    const db = env && env.BOT_DB ? env.BOT_DB : null;
    const url = new URL(request.url);

    if (url.pathname === "/setup") {
      if (!botToken || botToken.includes("PASTE_YOUR")) {
        return new Response(
          "<h2>⚠️ BOT_TOKEN Missing!</h2><p>Please add <b>BOT_TOKEN</b> in Cloudflare Settings &rarr; Variables and Secrets.</p>",
          { headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }

      const webhookUrl = `${url.origin}/webhook`;
      const tgRes = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`
      );
      const tgData = await tgRes.json();

      let html = `<h2>${tgData.ok ? "✅ Stable Music Bot Restored!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Admin ID Locked To:</b> ${ADMIN_ID}</p>`;
      html += `<p><b>Database:</b> ${db ? "✅ Connected (KV)" : "⚡ Fast RAM Cache"}</p>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        await handleUpdate(update, botToken, geminiKey, db);
      } catch (err) {
        console.error("Webhook error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response(
      `🎵 SR Music Downloader Bot is Running!\nVisit ${url.origin}/setup to verify webhook.`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

async function handleUpdate(update, botToken, geminiKey, db) {
  // 1. Handle Inline Button Clicks
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const data = cb.data || "";

    await registerUser(db, userId);

    if (data === "verify_join") {
      const joined = await isUserInChannel(botToken, userId);
      if (joined) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Verified! Send any song name now."
        });
        await sendWelcomeMenu(botToken, chatId, userId);
      } else {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⚠️ Please join ${CHANNEL_USERNAME} first, then tap Verify!`,
          show_alert: true
        });
      }
      return;
    }

    // Admin Handlers (Locked to 5527067319)
    if (data.startsWith("admin_")) {
      if (userId !== ADMIN_ID) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "⛔ Unauthorized: Admin only.",
          show_alert: true
        });
        return;
      }

      if (data === "admin_panel" || data === "admin_refresh") {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📊 Refreshing live stats..."
        });
        await sendAdminPanel(botToken, db, chatId, cb.message.message_id);
        return;
      }

      if (data === "admin_export_users") {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📥 Exporting user database..."
        });
        await exportUsersFile(botToken, db, chatId);
        return;
      }

      if (data === "admin_broadcast_start") {
        ADMIN_BROADCAST_MODE = true;
        if (db) await db.put("admin_broadcast_mode", "true");
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📢 Broadcast Mode Activated!"
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "📢 *Admin Broadcast Mode Active*\n\nSend or forward *any message* right now to broadcast it to all bot users!\n\n_Tap Cancel below if you change your mind._",
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "❌ Cancel Broadcast", callback_data: "admin_broadcast_cancel" }]]
          }
        });
        return;
      }

      if (data === "admin_broadcast_cancel") {
        ADMIN_BROADCAST_MODE = false;
        if (db) await db.put("admin_broadcast_mode", "false");
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Broadcast cancelled."
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "✅ *Broadcast Cancelled.*",
          parse_mode: "Markdown"
        });
        return;
      }
      return;
    }

    // Song Selection
    if (data.startsWith("dl|")) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "🎧 Preparing your playable MP3..."
      });

      await incrementStat(db, "downloads");

      const songId = data.slice(3);
      let track = SONG_CACHE.get(songId);

      const loadingMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⬇️ _Uploading playable MP3 track to Telegram..._",
        parse_mode: "Markdown"
      });

      if (!track && songId) {
        track = await fetchSaavnSongById(songId);
      }

      await sendPlayableMp3(botToken, chatId, loadingMsg.result?.message_id, track);
      return;
    }
    return;
  }

  // 2. Handle Text Messages
  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : chatId;
  const text = (msg.text || msg.caption || "").trim();

  await registerUser(db, userId);

  // Admin Commands & Broadcast Interceptor
  if (userId === ADMIN_ID) {
    if (text === "/stats" || text === "/admin") {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await sendAdminPanel(botToken, db, chatId, null);
      return;
    }

    if (text === "/cancel") {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "✅ *Broadcast mode cancelled.*",
        parse_mode: "Markdown"
      });
      return;
    }

    if (text.startsWith("/broadcast ")) {
      const bText = text.replace("/broadcast ", "").trim();
      if (bText) {
        await executeBroadcastText(botToken, db, chatId, bText);
        return;
      }
    }

    const isBroadcastActive =
      ADMIN_BROADCAST_MODE || (db && (await db.get("admin_broadcast_mode")) === "true");

    if (isBroadcastActive && !text.startsWith("/")) {
      ADMIN_BROADCAST_MODE = false;
      if (db) await db.put("admin_broadcast_mode", "false");
      await executeBroadcastCopy(botToken, db, chatId, msg.message_id);
      return;
    }
  }

  // Force-Join Channel Gatekeeper
  const isMember = await isUserInChannel(botToken, userId);
  if (!isMember) {
    const channelHandle = CHANNEL_USERNAME.replace("@", "");
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `🔒 *Welcome to SR Music — 320kbps MP3 Bot!*\n\nTo keep this bot 100% free and download unlimited playable MP3 songs, please join our official hub ${CHANNEL_USERNAME} first:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: `📢 Join ${CHANNEL_USERNAME}`, url: `https://t.me/${channelHandle}` }],
          [{ text: "✅ I Joined — Unlock Bot", callback_data: "verify_join" }]
        ]
      }
    });
    return;
  }

  if (text === "/start" || text === "/help") {
    await sendWelcomeMenu(botToken, chatId, userId);
    return;
  }

  if (!text) return;

  await runSongSearchAndShowButtons(botToken, db, chatId, text);
}

// Welcome Menu
async function sendWelcomeMenu(botToken, chatId, userId) {
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const keyboard = [
    [{ text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }]
  ];

  if (userId === ADMIN_ID) {
    keyboard.push([{ text: "🛠️ Admin Panel & Broadcast (Owner Only)", callback_data: "admin_panel" }]);
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🎵 *Instant 320kbps MP3 Music Downloader*\n\nJust type and send:\n• *Any Song Name* (e.g., _Pal Pal Dil Ke Paas_, _Kesariya_)\n• *Song + Singer* (e.g., _Tum Hi Ho Arijit Singh_)\n\nI will show you the top matching tracks—tap any button to download the directly playable \`.mp3\`!`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Core Search and Button Generator
async function runSongSearchAndShowButtons(botToken, db, chatId, text) {
  await incrementStat(db, "searches");

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🔍 _Searching top matches for "${escapeMd(text)}"..._`,
    parse_mode: "Markdown"
  });

  const songs = await searchTopSongs(text, 5);

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: statusMsg.result.message_id
    });
  }

  if (songs.length === 0) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "😕 *No matching songs found.*\n\nTry typing the song title along with the singer name (for example: `Pal Pal Dil Ke Paas Kishore Kumar`).",
      parse_mode: "Markdown"
    });
    return;
  }

  const keyboard = [];
  let listText = `🎶 *Top Matches for "${escapeMd(text)}":*\n\n`;

  songs.forEach((song, idx) => {
    const num = idx + 1;
    SONG_CACHE.set(song.id, song);
    const artistStr = song.artist ? ` — ${song.artist}` : "";
    listText += `*${num}.* *${escapeMd(song.title)}*${escapeMd(artistStr)}\n`;
    const btnLabel = `🎵 ${num}. ${song.title}${artistStr}`.slice(0, 60);
    keyboard.push([{ text: btnLabel, callback_data: `dl|${song.id}` }]);
  });

  listText += `\n👇 _Tap a button below for instant playable MP3:_`;

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: listText,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Robust Multi-Endpoint JioSaavn Search
async function searchTopSongs(query, limit = 5) {
  const saavnEndpoints = [
    `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(query)}&limit=15`,
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=15`,
    `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}&limit=15`
  ];

  for (const endpoint of saavnEndpoints) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) continue;
      const json = await res.json();
      const list = Array.isArray(json)
        ? json
        : (json.data?.results || json.results || []);

      if (list.length > 0) {
        const unique = [];
        const seen = new Set();
        for (const item of list) {
          const parsed = normalizeSaavnSong(item);
          if (parsed && parsed.audioUrl) {
            const sig = `${parsed.title.toLowerCase().slice(0, 15)}_${parsed.artist.toLowerCase().slice(0, 8)}`;
            if (!seen.has(sig)) {
              seen.add(sig);
              unique.push(parsed);
            }
          }
          if (unique.length >= limit) break;
        }
        if (unique.length > 0) return unique;
      }
    } catch (e) {}
  }

  // Backup: iTunes Global Search for Non-Indian Tracks
  try {
    const itunesRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=${limit}`
    );
    if (itunesRes.ok) {
      const itunesData = await itunesRes.json();
      if (itunesData.results && itunesData.results.length > 0) {
        const itunesList = [];
        for (const item of itunesData.results) {
          if (item.previewUrl) {
            itunesList.push({
              id: `itunes_${item.trackId}`,
              title: item.trackName,
              artist: item.artistName,
              album: item.collectionName || "",
              image: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : null,
              audioUrl: item.previewUrl
            });
          }
        }
        if (itunesList.length > 0) return itunesList;
      }
    }
  } catch (e) {}

  return [];
}

async function fetchSaavnSongById(songId) {
  const endpoints = [
    `https://saavn.sumit.co/api/songs/${encodeURIComponent(songId)}`,
    `https://saavn.dev/api/songs/${encodeURIComponent(songId)}`
  ];
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep);
      if (!res.ok) continue;
      const json = await res.json();
      const songObj = Array.isArray(json.data) ? json.data[0] : (json.data || json[0]);
      if (songObj) {
        const item = normalizeSaavnSong(songObj);
        if (item && item.audioUrl) return item;
      }
    } catch (e) {}
  }
  return null;
}

function normalizeSaavnSong(song) {
  const downloads = song.downloadUrl || song.download_url || [];
  let bestAudio = null;
  if (Array.isArray(downloads) && downloads.length > 0) {
    const high = downloads[downloads.length - 1];
    bestAudio = high?.url || high?.link;
  } else if (typeof song.media_url === "string") {
    bestAudio = song.media_url;
  }

  const images = song.image || [];
  let bestImage = null;
  if (Array.isArray(images) && images.length > 0) {
    bestImage = images[images.length - 1]?.url || images[images.length - 1]?.link;
  } else if (typeof song.image === "string") {
    bestImage = song.image;
  }

  const id = String(song.id || Math.random().toString(36).slice(2, 10));
  const title = cleanHtmlEntities(song.name || song.title || song.song || "Track").trim();
  const artist = cleanHtmlEntities(
    song.artists?.primary?.map(a => a.name).join(", ") ||
    song.primaryArtists ||
    song.singers ||
    ""
  ).trim();

  const album = cleanHtmlEntities(song.album?.name || song.album || "");
  const duration = song.duration ? Number(song.duration) : 0;

  return { id, title, artist, album, duration, image: bestImage, audioUrl: bestAudio };
}

// Clean and Reliable MP3 Sender (Loads in Telegram's Native Player)
async function sendPlayableMp3(botToken, chatId, loadingMsgId, track) {
  if (!track || !track.audioUrl) {
    if (loadingMsgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
    }
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Could not fetch audio stream for this track. Please try another version from the list!"
    });
    return;
  }

  const finalTitle = track.title || "Track";
  const finalArtist = track.artist || "";
  const safeFileName = `${finalTitle}${finalArtist ? " - " + finalArtist : ""}`.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) + ".mp3";
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const shareText = encodeURIComponent(`Download 320kbps MP3s free on ${BOT_USERNAME} 🎵`);
  const shareUrl = `https://t.me/share/url?url=https://t.me/${BOT_USERNAME.replace("@", "")}&text=${shareText}`;

  const actionButtons = {
    inline_keyboard: [
      [{ text: "📲 Share Bot", url: shareUrl }],
      [{ text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }]
    ]
  };

  try {
    const audioRes = await fetch(track.audioUrl);
    if (!audioRes.ok) throw new Error("Audio CDN fetch failed");
    const audioBuffer = await audioRes.arrayBuffer();

    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("title", finalTitle);
    form.append("performer", finalArtist || "SR Music");
    if (track.duration) {
      form.append("duration", String(track.duration));
    }
    form.append(
      "caption",
      `🎵 *${escapeMd(finalTitle)}*\n${finalArtist ? `🎤 ${escapeMd(finalArtist)}\n` : ""}${track.album ? `💿 _${escapeMd(track.album)}_\n` : ""}\n⚡ _Downloaded via ${BOT_USERNAME} • ${CHANNEL_USERNAME}_`
    );
    form.append("parse_mode", "Markdown");
    form.append("reply_markup", JSON.stringify(actionButtons));

    if (track.image) {
      try {
        const thumbRes = await fetch(track.image);
        if (thumbRes.ok) {
          const thumbBuf = await thumbRes.arrayBuffer();
          form.append("thumbnail", new Blob([thumbBuf], { type: "image/jpeg" }), "cover.jpg");
        }
      } catch (e) {}
    }

    form.append("audio", new Blob([audioBuffer], { type: "audio/mpeg" }), safeFileName);

    const uploadRes = await fetch(`https://api.telegram.org/bot${botToken}/sendAudio`, {
      method: "POST",
      body: form
    });
    const uploadData = await uploadRes.json();

    if (loadingMsgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
    }

    if (uploadData.ok) return;
  } catch (err) {
    console.error("FormData upload fallback:", err);
  }

  if (loadingMsgId) {
    await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
  }
  await tgApi(botToken, "sendAudio", {
    chat_id: chatId,
    audio: track.audioUrl,
    title: finalTitle,
    performer: finalArtist || "SR Music",
    caption: `🎵 *${escapeMd(finalTitle)}* — ${escapeMd(finalArtist)}\n⚡ _via ${BOT_USERNAME} • ${CHANNEL_USERNAME}_`,
    parse_mode: "Markdown",
    reply_markup: actionButtons
  });
}

// User Tracking & Database
async function registerUser(db, userId) {
  if (!userId) return;
  const numId = Number(userId);
  MEM_USERS.add(numId);

  if (db) {
    try {
      const existing = await db.get(`u_${numId}`);
      if (!existing) {
        await db.put(`u_${numId}`, new Date().toISOString().slice(0, 10));
        const raw = await db.get("master_users_list");
        const list = raw ? JSON.parse(raw) : [ADMIN_ID];
        if (!list.includes(numId)) {
          list.push(numId);
          await db.put("master_users_list", JSON.stringify(list));
        }
      }
    } catch (e) {}
  }
}

async function getAllUsers(db) {
  if (db) {
    try {
      const raw = await db.get("master_users_list");
      if (raw) {
        const list = JSON.parse(raw);
        list.forEach(id => MEM_USERS.add(Number(id)));
      }
    } catch (e) {}
  }
  return Array.from(MEM_USERS);
}

async function incrementStat(db, key) {
  MEM_STATS[key] = (MEM_STATS[key] || 0) + 1;
  if (db) {
    try {
      const cur = Number((await db.get(`stat_${key}`)) || 0) + 1;
      await db.put(`stat_${key}`, String(cur));
    } catch (e) {}
  }
}

async function getStatsData(db) {
  const users = await getAllUsers(db);
  let searches = MEM_STATS.searches;
  let downloads = MEM_STATS.downloads;
  if (db) {
    try {
      const s = await db.get("stat_searches");
      const d = await db.get("stat_downloads");
      if (s) searches = Math.max(searches, Number(s));
      if (d) downloads = Math.max(downloads, Number(d));
    } catch (e) {}
  }
  return {
    userCount: users.length,
    searches,
    downloads
  };
}

async function getChannelMemberCount(botToken) {
  try {
    const res = await tgApi(botToken, "getChatMemberCount", {
      chat_id: CHANNEL_USERNAME
    });
    if (res && res.ok) return res.result;
  } catch (e) {}
  return null;
}

async function isUserInChannel(botToken, userId) {
  try {
    const res = await tgApi(botToken, "getChatMember", {
      chat_id: CHANNEL_USERNAME,
      user_id: userId
    });
    if (!res.ok || !res.result) return true;
    const status = res.result.status;
    return status === "member" || status === "administrator" || status === "creator";
  } catch (e) {}
  return true;
}

// Exports User List as .txt File
async function exportUsersFile(botToken, db, adminChatId) {
  const users = await getAllUsers(db);
  const fileContent = users.join("\n");

  const form = new FormData();
  form.append("chat_id", String(adminChatId));
  form.append("caption", `📊 *SR Music Bot — User Database Export*\nTotal Unique Users: ${users.length}\nDate: ${new Date().toISOString().slice(0, 10)}`);
  form.append("parse_mode", "Markdown");
  form.append("document", new Blob([fileContent], { type: "text/plain" }), "users_list.txt");

  await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
    method: "POST",
    body: form
  });
}

// Broadcast Message Copy Engine
async function executeBroadcastCopy(botToken, db, adminChatId, messageId) {
  const users = await getAllUsers(db);
  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `⏳ _Broadcasting message to ${users.length} registered users..._`,
    parse_mode: "Markdown"
  });

  let sent = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      const res = await tgApi(botToken, "copyMessage", {
        chat_id: uid,
        from_chat_id: adminChatId,
        message_id: messageId
      });
      if (res && res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: adminChatId,
      message_id: statusMsg.result.message_id
    });
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Delivered:* ${sent} users\n• 🚫 *Failed / Blocked:* ${failed} users\n• 📊 *Total Target Base:* ${users.length} users`,
    parse_mode: "Markdown"
  });
}

async function executeBroadcastText(botToken, db, adminChatId, text) {
  const users = await getAllUsers(db);
  let sent = 0;
  let failed = 0;

  for (const uid of users) {
    try {
      const res = await tgApi(botToken, "sendMessage", {
        chat_id: uid,
        text: text,
        parse_mode: "Markdown"
      });
      if (res && res.ok) sent++;
      else failed++;
    } catch (e) {
      failed++;
    }
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Delivered:* ${sent} users\n• 🚫 *Failed:* ${failed} users`,
    parse_mode: "Markdown"
  });
}

async function sendAdminPanel(botToken, db, chatId, editMsgId) {
  const stats = await getStatsData(db);
  const channelMembers = await getChannelMemberCount(botToken);

  let text = `🛠️ *SR Bots Club — Owner Admin Panel*\n`;
  text += `👤 *Admin ID:* \`${ADMIN_ID}\`\n\n`;
  text += `📊 *Detailed Live Statistics:*\n`;
  text += `• 👥 *Total Unique Bot Users:* ${stats.userCount}\n`;
  if (channelMembers) {
    text += `• 📢 *${CHANNEL_USERNAME} Subscribers:* ${channelMembers}\n`;
  }
  text += `• 🔍 *Total Song Searches:* ${stats.searches}\n`;
  text += `• 🎧 *Total MP3 Downloads:* ${stats.downloads}\n`;
  text += `• 💾 *Storage Engine:* ${db ? "Permanent Cloudflare KV (`BOT_DB`)" : "⚡ Fast RAM Mode"}\n\n`;
  text += `_Tap a button below to broadcast an announcement, export your user list, or refresh stats:_`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "📢 Broadcast to All Users", callback_data: "admin_broadcast_start" }],
      [
        { text: "📥 Export Users (.txt)", callback_data: "admin_export_users" },
        { text: "🔄 Refresh Stats", callback_data: "admin_refresh" }
      ]
    ]
  };

  if (editMsgId) {
    await tgApi(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: reply_markup
    });
  } else {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: reply_markup
    });
  }
}

function cleanHtmlEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'");
}

function escapeMd(str) {
  return String(str).replace(/([_*`\[])/g, "");
}

async function tgApi(botToken, method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}
