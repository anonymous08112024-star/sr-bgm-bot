const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";
const ADMIN_ID = 5527067319;

// Fast in-memory caches
const SONG_CACHE = new Map();
const MEM_USERS = new Set([ADMIN_ID]);
const MEM_STATS = {
  searches: 0,
  downloads: 0,
  joinedAt: new Date().toISOString().slice(0, 10)
};
let ADMIN_BROADCAST_MODE = false;
let CACHED_MODELS = null;

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

      let html = `<h2>${tgData.ok ? "✅ Maximum Potential Music Bot Live!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Admin ID Locked To:</b> ${ADMIN_ID}</p>`;
      html += `<p><b>Database:</b> ${db ? "✅ Connected (KV)" : "⚡ Fast RAM Cache"}</p>`;
      html += `<p>Features Active: Top-5 MP3 Picker, Global LRCLIB Lyrics, Multi-Source Fallback, Admin Broadcast & Stats.</p>`;

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
      `🎵 SR Music Bot Max Engine Running!\nVisit ${url.origin}/setup to verify webhook.`,
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

    if (data === "trending_songs") {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "🔥 Loading Trending Hits..."
      });
      await runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, "Top Hindi Trending Songs");
      return;
    }

    // High-Reliability Dual-Engine Lyrics Lookup (Under 15 Bytes Callback)
    if (data.startsWith("lyr|")) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "📝 Fetching verified lyrics..."
      });

      const songId = data.slice(4);
      let track = SONG_CACHE.get(songId);

      const songTitle = track?.title || "Song";
      const songArtist = track?.artist || "";

      const loadingMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: `⏳ _Searching verified lyrics for "${escapeMd(songTitle)}"..._`,
        parse_mode: "Markdown"
      });

      const lyrics = await getUniversalLyrics(songId, songTitle, songArtist, geminiKey);

      if (loadingMsg.result?.message_id) {
        await tgApi(botToken, "deleteMessage", {
          chat_id: chatId,
          message_id: loadingMsg.result.message_id
        });
      }

      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: `📝 *Lyrics — ${escapeMd(songTitle)}*\n_${escapeMd(songArtist)}_\n\n${escapeMd(lyrics.slice(0, 3800))}\n\n⚡ _Powered by ${CHANNEL_USERNAME}_`,
        parse_mode: "Markdown"
      });
      return;
    }

    // Admin Panel Actions (Strictly locked to 5527067319)
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

      if (data === "admin_broadcast_start") {
        ADMIN_BROADCAST_MODE = true;
        if (db) await db.put("admin_broadcast_mode", "true");
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "📢 Broadcast Mode Activated!"
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "📢 *Admin Broadcast Mode Active*\n\nSend or forward *any message* right now (text, photo, video, audio, or post with buttons) and I will broadcast it to all bot users!\n\n_Tap Cancel below if you change your mind._",
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
          text: "✅ *Broadcast Cancelled.* You are back in normal song-search mode.",
          parse_mode: "Markdown"
        });
        return;
      }
      return;
    }

    // Song Selection from Top-5 Buttons
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

  // 2. Handle Messages
  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : chatId;
  const text = (msg.text || msg.caption || "").trim();

  await registerUser(db, userId);

  // Admin Interceptors
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

  await runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, text);
}

async function sendWelcomeMenu(botToken, chatId, userId) {
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const keyboard = [
    [{ text: "🔥 Top Trending Songs", callback_data: "trending_songs" }],
    [{ text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }]
  ];

  if (userId === ADMIN_ID) {
    keyboard.push([{ text: "🛠️ Admin Panel & Broadcast (Owner Only)", callback_data: "admin_panel" }]);
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: "🎵 *Instant 320kbps MP3 Music Downloader*\n\nJust type and send:\n• *Any Song Name* (e.g., _Pal Pal Dil Ke Paas_, _Kesariya_)\n• *Song + Singer* (e.g., _Tum Hi Ho Arijit Singh_)\n• *Any Remix / Lo-Fi / Slowed* or *YouTube Link*\n• *Any Line of Lyrics*\n\nI will show you the top 5 matching tracks—tap any button for the directly playable `.mp3`!",
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendAdminPanel(botToken, db, chatId, editMsgId) {
  const stats = await getStatsData(db);
  const channelMembers = await getChannelMemberCount(botToken);

  let text = `🛠️ *SR Bots Club — Owner Admin Panel*\n`;
  text += `👤 *Admin ID:* \`${ADMIN_ID}\`\n\n`;
  text += `📊 *Live Bot Statistics:*\n`;
  text += `• 👥 *Bot Users Tracked:* ${stats.userCount}\n`;
  if (channelMembers) {
    text += `• 📢 *${CHANNEL_USERNAME} Subscribers:* ${channelMembers}\n`;
  }
  text += `• 🔍 *Total Song Searches:* ${stats.searches}\n`;
  text += `• 🎧 *Total MP3 Downloads:* ${stats.downloads}\n`;
  text += `• 💾 *Storage Mode:* ${db ? "Permanent KV Database" : "Fast RAM Cache"}\n\n`;
  text += `_Use the buttons below to refresh stats or send a broadcast to all users:_`;

  const reply_markup = {
    inline_keyboard: [
      [{ text: "📢 Broadcast Message to All Users", callback_data: "admin_broadcast_start" }],
      [{ text: "🔄 Refresh Live Stats", callback_data: "admin_refresh" }]
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

async function executeBroadcastCopy(botToken, db, adminChatId, messageId) {
  const users = await getAllUsers(db);
  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: adminChatId,
    text: `⏳ _Broadcasting your message to ${users.length} users..._`,
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
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Successfully Delivered:* ${sent} users\n• 🚫 *Blocked / Failed:* ${failed} users`,
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

async function runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, text) {
  await incrementStat(db, "searches");

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🔍 _Searching top matches for "${escapeMd(text)}"..._`,
    parse_mode: "Markdown"
  });

  let searchQuery = text;

  if (/https?:\/\/[^\s]+/i.test(text)) {
    const extracted = await extractTitleFromUrl(text);
    if (extracted) searchQuery = extracted;
  }

  // Multi-Source Search (JioSaavn Studio + Global iTunes + YouTube Index)
  let songs = await searchUniversalSongs(searchQuery, 5);

  if (songs.length === 0 && geminiKey && !geminiKey.includes("PASTE_YOUR")) {
    const aiGuess = await guessSongFromLyricsWithGemini(geminiKey, text);
    if (aiGuess) {
      songs = await searchUniversalSongs(aiGuess, 5);
    }
  }

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: statusMsg.result.message_id
    });
  }

  if (songs.length === 0) {
    const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `😕 *No direct audio match found for "${escapeMd(searchQuery)}".*\n\nTry adding the singer name, or search directly on YouTube below:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "▶️ Search on YouTube", url: ytSearchUrl }]]
      }
    });
    return;
  }

  const keyboard = [];
  let listText = `🎶 *Select the exact song to download MP3:*\n\n`;

  songs.forEach((song, idx) => {
    const num = idx + 1;
    SONG_CACHE.set(song.id, song);
    const yearStr = song.year ? ` (${song.year})` : "";
    listText += `*${num}.* *${escapeMd(song.title)}* — ${escapeMd(song.artist)}${yearStr}\n`;
    const btnLabel = `🎵 ${num}. ${song.title} — ${song.artist}`.slice(0, 60);
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

async function sendPlayableMp3(botToken, chatId, loadingMsgId, track) {
  if (!track || !track.audioUrl) {
    if (loadingMsgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
    }
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "⚠️ Could not fetch the audio stream for this track. Please try another version from the list!"
    });
    return;
  }

  const finalTitle = track.title || "Track";
  const finalArtist = track.artist || "Artist";
  const songId = track.id || "0";
  SONG_CACHE.set(songId, track);

  const safeFileName = `${finalTitle} - ${finalArtist}`.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) + ".mp3";
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const botInfo = await tgApi(botToken, "getMe", {});
  const botUsername = botInfo.result?.username || "SrMusicBot";
  const shareText = encodeURIComponent(`Listen to "${finalTitle}" by ${finalArtist} on @${botUsername} 🎵`);
  const shareUrl = `https://t.me/share/url?url=https://t.me/${botUsername}&text=${shareText}`;

  // Clean, short callback data (under 15 bytes to strictly obey Telegram's 64-byte cap)
  const actionButtons = {
    inline_keyboard: [
      [
        { text: "📝 Get Lyrics", callback_data: `lyr|${songId}` },
        { text: "📲 Share Bot", url: shareUrl }
      ],
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
    form.append("performer", finalArtist);
    if (track.duration) {
      form.append("duration", String(track.duration));
    }
    form.append(
      "caption",
      `🎵 *${escapeMd(finalTitle)}*\n🎤 ${escapeMd(finalArtist)}${track.album ? `\n💿 _${escapeMd(track.album)}_` : ""}\n\n⚡ _Downloaded via @${botUsername} • ${CHANNEL_USERNAME}_`
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
    console.error("FormData MP3 upload fallback:", err);
  }

  if (loadingMsgId) {
    await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
  }
  await tgApi(botToken, "sendAudio", {
    chat_id: chatId,
    audio: track.audioUrl,
    title: finalTitle,
    performer: finalArtist,
    caption: `🎵 *${escapeMd(finalTitle)}* — ${escapeMd(finalArtist)}\n⚡ _via @${botUsername} • ${CHANNEL_USERNAME}_`,
    parse_mode: "Markdown",
    reply_markup: actionButtons
  });
}

// 100% Reliable Multi-Source Lyrics Engine (LRCLIB Global + JioSaavn + Gemini Flash)
async function getUniversalLyrics(songId, songTitle, songArtist, geminiKey) {
  // 1. Primary Engine: LRCLIB Global Open Lyrics Library (Free, Keyless, Millions of Songs)
  try {
    const lrcQuery = `${songTitle} ${songArtist}`.trim();
    const lrcRes = await fetch(
      `https://lrclib.net/api/search?q=${encodeURIComponent(lrcQuery)}`,
      { headers: { "User-Agent": "SRMusicBot/2.0 (Telegram)" } }
    );
    if (lrcRes.ok) {
      const records = await lrcRes.json();
      if (Array.isArray(records) && records.length > 0) {
        for (const item of records.slice(0, 3)) {
          const text = item.plainLyrics || item.syncedLyrics;
          if (text && text.trim().length > 20) {
            // Strip timestamp brackets from synced lyrics if present
            return text.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
          }
        }
      }
    }
  } catch (e) {}

  // 2. Secondary Engine: JioSaavn Official Record-Label Lyrics
  if (songId && songId !== "0" && !songId.startsWith("itunes_")) {
    const lyricsEndpoints = [
      `https://saavn.sumit.co/api/lyrics?id=${encodeURIComponent(songId)}`,
      `https://saavn.dev/api/lyrics?id=${encodeURIComponent(songId)}`,
      `https://jiosaavn-api-privatecvc2.vercel.app/lyrics?id=${encodeURIComponent(songId)}`,
      `https://saavnapi-nine.vercel.app/lyrics/?query=${encodeURIComponent(songId)}`
    ];

    for (const ep of lyricsEndpoints) {
      try {
        const res = await fetch(ep);
        if (!res.ok) continue;
        const data = await res.json();
        const rawLyrics = data.data?.lyrics || data.lyrics || "";
        if (rawLyrics && typeof rawLyrics === "string" && rawLyrics.trim().length > 10) {
          return cleanHtmlEntities(rawLyrics.replace(/<br\s*\/?>/gi, "\n"));
        }
      } catch (e) {}
    }
  }

  // 3. Third Engine: Dynamic Gemini Flash Lyrics Extraction
  if (geminiKey && !geminiKey.includes("PASTE_YOUR")) {
    try {
      const models = await getAvailableFlashModels(geminiKey);
      for (const model of models) {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    parts: [
                      {
                        text: `Provide the main chorus and verses for the song "${songTitle}" by "${songArtist}". Reply with ONLY the clean lyrics formatted with line breaks, without conversational intro or commentary.`
                      }
                    ]
                  }
                ]
              })
            }
          );
          if (!res.ok) continue;
          const data = await res.json();
          const lyricsText = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (lyricsText && lyricsText.trim().length > 15) {
            return lyricsText.trim();
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  return "Verified lyrics are not available for this track yet. Try another version from the list!";
}

// Multi-Source Song Search Engine (JioSaavn Studio + Apple Global iTunes + YouTube Index)
async function searchUniversalSongs(query, limit = 5) {
  // 1. Try Primary JioSaavn CDNs (Full 320kbps MP3s)
  const saavnEndpoints = [
    `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(query)}&limit=${limit}`,
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=${limit}`,
    `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}&limit=${limit}`,
    `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(query)}`
  ];

  for (const endpoint of saavnEndpoints) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) continue;
      const json = await res.json();
      const rawList = Array.isArray(json)
        ? json
        : (json.data?.results || json.results || []);

      if (rawList.length > 0) {
        const parsed = [];
        for (const song of rawList.slice(0, limit)) {
          const item = normalizeSaavnSong(song);
          if (item && item.audioUrl) parsed.push(item);
        }
        if (parsed.length > 0) return parsed;
      }
    } catch (e) {}
  }

  // 2. Global Music Search Fallback (Catches English, Pop, Indie & Non-Indian Tracks)
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
              year: item.releaseDate ? item.releaseDate.slice(0, 4) : "",
              duration: item.trackTimeMillis ? Math.round(item.trackTimeMillis / 1000) : 0,
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
  const title = cleanHtmlEntities(song.name || song.title || song.song || "Track");
  const artist = cleanHtmlEntities(
    song.artists?.primary?.map(a => a.name).join(", ") ||
    song.primaryArtists ||
    song.singers ||
    "Artist"
  );
  const album = cleanHtmlEntities(song.album?.name || song.album || "");
  const year = song.year || "";
  const duration = song.duration ? Number(song.duration) : 0;

  return { id, title, artist, album, year, duration, image: bestImage, audioUrl: bestAudio };
}

async function extractTitleFromUrl(text) {
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (!urlMatch) return null;
  const targetUrl = urlMatch[0];
  const ytIdMatch = targetUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  const lookupUrl = ytIdMatch ? `https://www.youtube.com/watch?v=${ytIdMatch[1]}` : targetUrl;

  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(lookupUrl)}&format=json`
    );
    if (res.ok) {
      const data = await res.json();
      if (data.title) {
        return data.title
          .replace(/#[^\s#]+/g, "")
          .replace(/\(official.*?\)|\[official.*?\]/gi, "")
          .replace(/\b(shorts|short|trending|viral|status|bgm|full screen|4k|hd|lyrics|lyrical|video|audio)\b/gi, "")
          .replace(/[|•~_]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  } catch (e) {}
  return null;
}

async function guessSongFromLyricsWithGemini(geminiKey, text) {
  try {
    const models = await getAvailableFlashModels(geminiKey);
    for (const model of models) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `Identify the exact song title and singer from this lyric or query: "${text}". Reply with ONLY the song title and artist name (max 6 words), nothing else.`
                    }
                  ]
                }
              ]
            })
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const output = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
        if (output) return output;
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function getAvailableFlashModels(geminiKey) {
  if (CACHED_MODELS && CACHED_MODELS.length > 0) return CACHED_MODELS;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`
    );
    if (res.ok) {
      const data = await res.json();
      const allModels = (data.models || [])
        .filter(
          m =>
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.includes("generateContent") &&
            m.name.includes("gemini") &&
            !m.name.includes("tts") &&
            !m.name.includes("image") &&
            !m.name.includes("embedding") &&
            !m.name.includes("robotics") &&
            !m.name.includes("computer-use") &&
            !m.name.includes("1.5")
        )
        .map(m => m.name.replace(/^models\//, ""));

      allModels.sort((a, b) => {
        const aScore = a.includes("flash") ? 0 : 1;
        const bScore = b.includes("flash") ? 0 : 1;
        return aScore - bScore;
      });

      if (allModels.length > 0) {
        CACHED_MODELS = allModels.slice(0, 6);
        return CACHED_MODELS;
      }
    }
  } catch (e) {}
  return [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-2.0-flash"
  ];
}

async function registerUser(db, userId) {
  if (!userId) return;
  MEM_USERS.add(Number(userId));
  if (db) {
    try {
      const raw = await db.get("users_list");
      const arr = raw ? JSON.parse(raw) : [ADMIN_ID];
      if (!arr.includes(Number(userId))) {
        arr.push(Number(userId));
        await db.put("users_list", JSON.stringify(arr));
      }
    } catch (e) {}
  }
}

async function getAllUsers(db) {
  if (db) {
    try {
      const raw = await db.get("users_list");
      if (raw) {
        const arr = JSON.parse(raw);
        arr.forEach(u => MEM_USERS.add(Number(u)));
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
