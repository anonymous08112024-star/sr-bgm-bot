const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";
const ADMIN_ID = 5527067319;
const BOT_USERNAME = "@InstantMP3SongBot";

// In-memory cache + persistent fallback
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

      let html = `<h2>${tgData.ok ? "✅ SR Music Engine V4 Live!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Admin ID Locked To:</b> ${ADMIN_ID}</p>`;
      html += `<p><b>Anti-Mashup & Tag Eraser:</b> Active</p>`;

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
      `🎵 SR Music Bot V4 Running!\nVisit ${url.origin}/setup to verify webhook.`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

async function handleUpdate(update, botToken, geminiKey, db) {
  // 1. Inline Query Mode (@InstantMP3SongBot song in any chat)
  if (update.inline_query) {
    await handleInlineQuery(update.inline_query, botToken);
    return;
  }

  // 2. Button Clicks
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

    if (data === "trending_songs" || data === "nav_charts") {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "🔥 Loading India's Top 10 Weekly Hits..."
      });
      await sendTopCharts(botToken, chatId);
      return;
    }

    if (data.startsWith("set_quality_")) {
      const q = data.replace("set_quality_", "");
      if (db) await db.put(`pref_q_${userId}`, q);
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: `✅ Audio Quality set to: ${q === "128" ? "Data Saver (128kbps)" : "Studio HD (320kbps)"}`
      });
      await sendSettingsMenu(botToken, db, chatId, userId, cb.message.message_id);
      return;
    }

    // Accurate Parallel Racing Lyrics
    if (data.startsWith("lyr|")) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "⚡ Racing lyrics servers in parallel..."
      });

      const parts = data.split("|");
      const songId = parts[1] || "";
      let track = await getTrackFromCacheOrDb(db, songId);
      const songTitle = track?.title || (parts[2] ? decodeURIComponent(parts[2]) : "Song");
      const songArtist = (track?.artist && track.artist !== "Artist") ? track.artist : "";

      const statusMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: `⏳ _Searching verified lyrics for "${escapeMd(songTitle)}"..._`,
        parse_mode: "Markdown"
      });

      const lyrics = await getParallelRacingLyrics(db, songId, songTitle, songArtist, geminiKey);

      if (statusMsg.result?.message_id) {
        await tgApi(botToken, "deleteMessage", {
          chat_id: chatId,
          message_id: statusMsg.result.message_id
        });
      }

      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: `📝 *Lyrics — ${escapeMd(songTitle)}*\n${songArtist ? `🎤 _${escapeMd(songArtist)}_\n\n` : "\n"}${escapeMd(lyrics.slice(0, 3800))}\n\n⚡ _Powered by ${CHANNEL_USERNAME}_`,
        parse_mode: "Markdown"
      });
      return;
    }

    // 1-Tap Presets (Slowed, Bass, Ringtone, Vibe) — Clean Song Name Fallback
    if (data.startsWith("slow|") || data.startsWith("bass|") || data.startsWith("ring|") || data.startsWith("vibe|")) {
      const parts = data.split("|");
      const type = parts[0];
      const songId = parts[1] || "";
      const embeddedTitle = parts[2] ? decodeURIComponent(parts[2]) : "";

      const track = await getTrackFromCacheOrDb(db, songId);
      const title = track?.title || embeddedTitle || "";
      const artist = track?.artist || "";

      if (!title || title.toLowerCase() === "song") {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Please search the song again to use presets."
        });
        return;
      }

      let label = "";
      let query = "";

      if (type === "slow") {
        label = "🌙 Fetching Slowed + Reverb version...";
        query = `${title} ${artist} slowed reverb`;
      } else if (type === "bass") {
        label = "🔊 Fetching Bass Boosted mix...";
        query = `${title} ${artist} bass boosted`;
      } else if (type === "ring") {
        label = `🔔 Fetching Ringtone for ${title}...`;
        query = `${title} ${artist} ringtone`;
      } else if (type === "vibe") {
        label = "🔀 Discovering similar songs...";
        query = artist ? `${artist} top songs` : `${title} songs`;
      }

      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: label
      });

      await runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, query);
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
      let track = await getTrackFromCacheOrDb(db, songId);

      const loadingMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⬇️ _Uploading playable MP3 track to Telegram..._",
        parse_mode: "Markdown"
      });

      const userPrefQ = db ? await db.get(`pref_q_${userId}`) : "320";

      if (!track?.audioUrl && track) {
        track = await resolveAudioForTrack(track, userPrefQ);
      }

      await sendPlayableMp3(botToken, chatId, loadingMsg.result?.message_id, track);
      return;
    }
    return;
  }

  // 3. Handle Text Messages
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

  // Force-Join Gatekeeper
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

  if (text === "/top" || text === "/charts") {
    await sendTopCharts(botToken, chatId);
    return;
  }

  if (text === "/settings" || text === "/quality") {
    await sendSettingsMenu(botToken, db, chatId, userId, null);
    return;
  }

  if (!text) return;

  await runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, text);
}

// Inline Query Engine
async function handleInlineQuery(inlineQuery, botToken) {
  const query = (inlineQuery.query || "").trim();
  const queryId = inlineQuery.id;

  if (!query) {
    await tgApi(botToken, "answerInlineQuery", {
      inline_query_id: queryId,
      results: [],
      switch_pm_text: "🎵 Type any song name to search...",
      switch_pm_parameter: "search"
    });
    return;
  }

  const songs = await searchYouTubeInnerTube(query, 6);
  const inlineResults = [];

  for (let i = 0; i < songs.length; i++) {
    const s = songs[i];
    const track = await resolveAudioForTrack(s, "320");
    if (track && track.audioUrl) {
      inlineResults.push({
        type: "audio",
        id: `inline_${s.id}_${i}`,
        audio_url: track.audioUrl,
        title: track.title,
        performer: track.artist || "SR Music",
        caption: `🎵 *${escapeMd(track.title)}* — ${escapeMd(track.artist)}\n⚡ _via ${CHANNEL_USERNAME}_`,
        parse_mode: "Markdown"
      });
    }
  }

  await tgApi(botToken, "answerInlineQuery", {
    inline_query_id: queryId,
    results: inlineResults,
    cache_time: 300
  });
}

// Welcome Menu with Actual Bot Handle
async function sendWelcomeMenu(botToken, chatId, userId) {
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const keyboard = [
    [
      { text: "🔥 Top Trending Hits", callback_data: "nav_charts" },
      { text: "⚙️ Audio Quality", callback_data: "set_quality_menu" }
    ],
    [{ text: `📢 Official Hub (${CHANNEL_USERNAME})`, url: `https://t.me/${channelHandle}` }]
  ];

  if (userId === ADMIN_ID) {
    keyboard.push([{ text: "🛠️ Admin Panel & Broadcast (Owner Only)", callback_data: "admin_panel" }]);
  }

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🎵 *Instant 320kbps MP3 Music Downloader*\n\nJust type and send:\n• *Any Song Name* (e.g., _Pal Pal_, _Kesariya_)\n• *Any Artist* (e.g., _Aleemrk_, _Afusic_, _Arijit_)\n• *Any YouTube / Shorts Link*\n\n⚡ *Pro Tip:* You can also type \`${BOT_USERNAME} song\` in any chat to share songs directly!`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Top Weekly Trending Charts Menu (/top)
async function sendTopCharts(botToken, chatId) {
  const topList = [
    "Pal Pal Afusic",
    "Cold Hours Aleemrk",
    "Sahiba Aditya Rikhari",
    "Jhoot Harmeeet",
    "Big Dawgs Hanumankind",
    "Kesariya Arijit Singh",
    "Tauba Tauba Karan Aujla",
    "Wake Me Up Avicii",
    "Winning Speech Karan Aujla",
    "Ishq Faheem Abdullah"
  ];

  const keyboard = [];
  let text = `🔥 *India's Top 10 Trending Hits This Week:*\n\n`;

  topList.forEach((song, idx) => {
    const num = idx + 1;
    text += `*${num}.* ${escapeMd(song)}\n`;
    keyboard.push([{ text: `▶️ ${num}. ${song}`, callback_data: `dl_top_${encodeURIComponent(song)}` }]);
  });

  text += `\n👇 _Tap a song button below to download the playable MP3:_`;

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard.slice(0, 5) }
  });
}

// Audio Quality Setting Menu (/settings)
async function sendSettingsMenu(botToken, db, chatId, userId, editMsgId) {
  const currentPref = db ? (await db.get(`pref_q_${userId}`)) || "320" : "320";
  const text = `⚙️ *Audio Download Settings*\n\nChoose your preferred download quality:\n\n• *💎 Studio HD (320kbps):* Maximum acoustic fidelity, original album quality (~8–10 MB)\n• *⚡ Data Saver (128kbps):* Ultra-fast downloads, saves mobile recharge data (~3–4 MB)\n\n📌 *Current Quality:* ${currentPref === "128" ? "⚡ Data Saver (128kbps)" : "💎 Studio HD (320kbps)"}`;

  const keyboard = [
    [
      { text: currentPref === "320" ? "✅ Studio HD (320k)" : "Studio HD (320k)", callback_data: "set_quality_320" },
      { text: currentPref === "128" ? "✅ Data Saver (128k)" : "Data Saver (128k)", callback_data: "set_quality_128" }
    ]
  ];

  if (editMsgId) {
    await tgApi(botToken, "editMessageText", {
      chat_id: chatId,
      message_id: editMsgId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
  } else {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

// Search and Button Generator
async function runSongSearchAndShowButtons(botToken, geminiKey, db, chatId, text) {
  await incrementStat(db, "searches");

  const statusMsg = await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `🔍 _Searching top trending matches for "${escapeMd(text)}"..._`,
    parse_mode: "Markdown"
  });

  let searchQuery = text;

  if (/https?:\/\/[^\s]+/i.test(text)) {
    const extracted = await extractTitleFromUrl(text);
    if (extracted) searchQuery = extracted;
  }

  let songs = await searchYouTubeInnerTube(searchQuery, 5);

  if (songs.length === 0) {
    songs = await searchJioSaavnDeduplicated(searchQuery, 5, "320", searchQuery.toLowerCase().includes("mashup"));
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
      text: `😕 *No direct audio match found for "${escapeMd(searchQuery)}".*\n\nTry searching on YouTube below:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "▶️ Search on YouTube", url: ytSearchUrl }]]
      }
    });
    return;
  }

  const keyboard = [];
  let listText = `🎶 *Top Matches for "${escapeMd(searchQuery)}":*\n\n`;

  for (let idx = 0; idx < songs.length; idx++) {
    const song = songs[idx];
    const num = idx + 1;

    SONG_CACHE.set(song.id, song);
    if (db) {
      try {
        await db.put(`track_${song.id}`, JSON.stringify(song));
      } catch (e) {}
    }

    const artistStr = song.artist ? ` — ${song.artist}` : "";
    listText += `*${num}.* *${escapeMd(song.title)}*${escapeMd(artistStr)}\n`;
    const btnLabel = `🎵 ${num}. ${song.title}${artistStr}`.slice(0, 60);
    keyboard.push([{ text: btnLabel, callback_data: `dl|${song.id}` }]);
  }

  listText += `\n👇 _Tap a button below for instant playable MP3:_`;

  await tgApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: listText,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
}

// Strict YouTube InnerTube Search with Username Eraser
async function searchYouTubeInnerTube(query, limit = 5) {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20230526.01.00",
              hl: "en",
              gl: "IN"
            }
          },
          query: query
        })
      }
    );

    if (!res.ok) return [];
    const data = await res.json();
    const contents =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const songs = [];
    const seenTitles = new Set();
    const wantsMashup = query.toLowerCase().includes("mashup") || query.toLowerCase().includes("remix");

    for (const item of contents) {
      const v = item.videoRenderer;
      if (!v || !v.videoId) continue;

      const rawTitle = v.title?.runs?.[0]?.text || "";
      const channel = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "";

      // Anti-Mashup Filter: If user didn't ask for a mashup, skip fan mashup titles
      if (!wantsMashup && /\b(mashup|fan made|mix)\b/i.test(rawTitle)) {
        continue;
      }

      const parsed = cleanYouTubeTitleAndArtist(rawTitle, channel);
      const signature = parsed.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15);

      if (!seenTitles.has(signature) && parsed.title.length > 1) {
        seenTitles.add(signature);
        const thumbs = v.thumbnail?.thumbnails || [];
        const bestThumb = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : null;

        songs.push({
          id: `yt_${v.videoId}`,
          videoId: v.videoId,
          title: parsed.title,
          artist: parsed.artist,
          album: "Single",
          image: bestThumb,
          audioUrl: null
        });
      }

      if (songs.length >= limit) break;
    }

    return songs;
  } catch (e) {
    return [];
  }
}

// Complete Username & Tag Eraser
function cleanYouTubeTitleAndArtist(title, channel) {
  let clean = title
    // Erase all @usernames completely (e.g. @AliSoomroMusic, @Talwiinder)
    .replace(/@[\w.]+/g, "")
    // Erase Prod, With, Feat tags that leave trailing words
    .replace(/\b(prod|prod by|produced by|with|feat|ft|featuring)\b[\s:.-]*[^|\-•()]*/gi, "")
    .replace(/#[^\s#]+/g, "")
    .replace(/\(official.*?\)|\[official.*?\]|\(video\)|\(audio\)|\(lyric.*?\)|\(music video\)/gi, "")
    .replace(/\b(official video|official audio|music video|lyric video|full song|hd|4k|status|shorts)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  let artistClean = channel
    .replace(/@[\w.]+/g, "")
    .replace(/ - Topic|VEVO/gi, "")
    .trim();

  const split = clean.split(/\s*[-–—|•]\s*/);
  if (split.length >= 2) {
    return {
      title: split[1].trim() || split[0].trim(),
      artist: split[0].trim() || artistClean
    };
  }

  return {
    title: clean || title,
    artist: artistClean
  };
}

// Audio Resolver with Strict Anti-Mashup & Title-Match Guard
async function resolveAudioForTrack(track, qualityPref = "320") {
  const cleanTitle = track.title.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Strict Title Match: Checks that the title actually matches the song, not a completely different song
  const isTitleMatch = (foundTitle, foundAlbum = "") => {
    if (!foundTitle) return false;
    const cleanFound = foundTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
    
    // Reject mashups when user wanted official solo song
    if ((foundTitle.toLowerCase().includes("mashup") || foundAlbum.toLowerCase().includes("haseen") || foundTitle.toLowerCase().includes(" x ")) && !track.title.toLowerCase().includes("mashup")) {
      return false;
    }
    
    return cleanFound.includes(cleanTitle) || cleanTitle.includes(cleanFound) || cleanTitle.slice(0, 5) === cleanFound.slice(0, 5);
  };

  const query = `${track.title} ${track.artist}`.trim();

  // 1. Try JioSaavn with Title + Artist
  const saavnResults = await searchJioSaavnDeduplicated(query, 5, qualityPref, false);
  for (const res of saavnResults) {
    if (res.audioUrl && isTitleMatch(res.title, res.album)) {
      return {
        ...track,
        audioUrl: res.audioUrl,
        album: res.album || track.album,
        image: res.image || track.image
      };
    }
  }

  // 2. Try JioSaavn with Title Alone
  const titleResults = await searchJioSaavnDeduplicated(track.title, 5, qualityPref, false);
  for (const res of titleResults) {
    if (res.audioUrl && isTitleMatch(res.title, res.album)) {
      return {
        ...track,
        audioUrl: res.audioUrl,
        album: res.album || track.album,
        image: res.image || track.image
      };
    }
  }

  // 3. Apple Global iTunes Match (High-Speed Backup for International & Indie Tracks)
  try {
    const itunesRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=3`
    );
    if (itunesRes.ok) {
      const itunesData = await itunesRes.json();
      if (itunesData.results && itunesData.results.length > 0) {
        for (const item of itunesData.results) {
          if (item.previewUrl && isTitleMatch(item.trackName, item.collectionName || "")) {
            return {
              ...track,
              audioUrl: item.previewUrl,
              image: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : track.image
            };
          }
        }
      }
    }
  } catch (e) {}

  return track;
}

// Retrieves Track Metadata from RAM or Permanent KV Database
async function getTrackFromCacheOrDb(db, songId) {
  if (SONG_CACHE.has(songId)) {
    return SONG_CACHE.get(songId);
  }
  if (db && songId) {
    try {
      const raw = await db.get(`track_${songId}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        SONG_CACHE.set(songId, parsed);
        return parsed;
      }
    } catch (e) {}
  }
  return null;
}

// Sends Playable MP3 with Presets (Embeds Safe Song Name in Callback Data)
async function sendPlayableMp3(botToken, chatId, loadingMsgId, track) {
  if (!track || !track.audioUrl) {
    if (loadingMsgId) {
      await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: loadingMsgId });
    }
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(track?.title + " " + track?.artist)}`;
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `⚠️ Could not fetch direct audio stream for *${escapeMd(track?.title || "Track")}*.\n\nYou can stream directly on YouTube:`,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[{ text: "▶️ Listen on YouTube", url: ytUrl }]]
      }
    });
    return;
  }

  const finalTitle = track.title || "Track";
  const finalArtist = (track.artist && track.artist !== "Artist") ? track.artist : "";
  const songId = track.id || "0";
  SONG_CACHE.set(songId, track);

  // Safe Short Title for Callback Buttons (under 20 chars, URL-safe)
  const safeParam = encodeURIComponent(finalTitle.slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, ""));
  const safeFileName = `${finalTitle}${finalArtist ? " - " + finalArtist : ""}`.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) + ".mp3";
  const channelHandle = CHANNEL_USERNAME.replace("@", "");
  const shareText = encodeURIComponent(`Download 320kbps MP3s free on ${BOT_USERNAME} 🎵`);
  const shareUrl = `https://t.me/share/url?url=https://t.me/${BOT_USERNAME.replace("@", "")}&text=${shareText}`;

  // Embedded Safe Song Name so Ringtone / Slowed never defaults to "Song"
  const actionButtons = {
    inline_keyboard: [
      [
        { text: "📝 Get Lyrics", callback_data: `lyr|${songId}|${safeParam}` },
        { text: "🔀 More Like This", callback_data: `vibe|${songId}|${safeParam}` }
      ],
      [
        { text: "🌙 Slowed + Reverb", callback_data: `slow|${songId}|${safeParam}` },
        { text: "🔊 Bass Boosted", callback_data: `bass|${songId}|${safeParam}` }
      ],
      [
        { text: "🔔 30s Hook / Ringtone", callback_data: `ring|${songId}|${safeParam}` },
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
    console.error("FormData MP3 upload fallback:", err);
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

// Parallel Racing Lyrics Engine
async function getParallelRacingLyrics(db, songId, songTitle, songArtist, geminiKey) {
  if (db && songId) {
    try {
      const cached = await db.get(`lyr_cache_${songId}`);
      if (cached) return cached;
    } catch (e) {}
  }

  const cleanTitle = songTitle.replace(/\(.*?\)|\[.*?\]/g, "").trim();
  const lrcQuery = songArtist && songArtist !== "Artist"
    ? `${cleanTitle} ${songArtist}`
    : cleanTitle;

  const racePromises = [];

  // Racer A: LRCLIB Global Open Lyrics Library
  racePromises.push(
    (async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2800);
      try {
        const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(lrcQuery)}`, {
          headers: { "User-Agent": "SRMusicBot/2.0 (Telegram)" },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const records = await res.json();
          if (Array.isArray(records) && records.length > 0) {
            for (const item of records.slice(0, 3)) {
              const text = item.plainLyrics || item.syncedLyrics;
              if (text && text.trim().length > 20) {
                return text.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "").trim();
              }
            }
          }
        }
      } catch (e) {}
      throw new Error("LRCLIB miss");
    })()
  );

  // Racer B: JioSaavn Official Records
  if (songId && !songId.startsWith("yt_") && !songId.startsWith("itunes_")) {
    racePromises.push(
      (async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2800);
        try {
          const res = await fetch(`https://saavn.sumit.co/api/lyrics?id=${encodeURIComponent(songId)}`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);
          if (res.ok) {
            const data = await res.json();
            const rawLyrics = data.data?.lyrics || data.lyrics || "";
            if (rawLyrics && typeof rawLyrics === "string" && rawLyrics.trim().length > 10) {
              return cleanHtmlEntities(rawLyrics.replace(/<br\s*\/?>/gi, "\n"));
            }
          }
        } catch (e) {}
        throw new Error("JioSaavn miss");
      })()
    );
  }

  try {
    const winnerLyrics = await Promise.any(racePromises);
    if (winnerLyrics && typeof winnerLyrics === "string") {
      if (db && songId) {
        await db.put(`lyr_cache_${songId}`, winnerLyrics);
      }
      return winnerLyrics;
    }
  } catch (err) {}

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
                        text: `Provide the main chorus and verses for the song "${songTitle}" by "${songArtist}". Reply with ONLY clean lyrics formatted with line breaks, without intro or commentary.`
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
            const clean = lyricsText.trim();
            if (db && songId) await db.put(`lyr_cache_${songId}`, clean);
            return clean;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  return "Verified lyrics are not available for this track yet. Try another version from the list!";
}

// Search with Anti-Mashup Filter
async function searchJioSaavnDeduplicated(query, limit = 5, qualityPref = "320", allowMashup = false) {
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
          // Reject mashups when user wanted official solo song
          const tLower = (item.name || item.title || item.song || "").toLowerCase();
          const aLower = (item.album?.name || item.album || "").toLowerCase();
          if (!allowMashup && (tLower.includes("mashup") || tLower.includes(" x ") || aLower.includes("haseen"))) {
            continue;
          }

          const parsed = normalizeSaavnSong(item, qualityPref);
          if (parsed && parsed.audioUrl) {
            const sig = parsed.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15);
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
  return [];
}

function normalizeSaavnSong(song, qualityPref = "320") {
  const downloads = song.downloadUrl || song.download_url || [];
  let bestAudio = null;
  if (Array.isArray(downloads) && downloads.length > 0) {
    if (qualityPref === "128" && downloads.length >= 2) {
      bestAudio = downloads[1]?.url || downloads[1]?.link;
    } else {
      const high = downloads[downloads.length - 1];
      bestAudio = high?.url || high?.link;
    }
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
  const title = cleanHtmlEntities(song.name || song.title || song.song || "Track")
    .replace(/@[\w.]+/g, "")
    .trim();
  
  let artist = cleanHtmlEntities(
    song.artists?.primary?.map(a => a.name).join(", ") ||
    song.primaryArtists ||
    song.singers ||
    ""
  ).replace(/@[\w.]+/g, "").trim();

  if (!artist || artist === "Artist") artist = "";

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
        const cleanRaw = data.title
          .replace(/@[\w.]+/g, "")
          .replace(/#[^\s#]+/g, "")
          .replace(/\(official.*?\)|\[official.*?\]/gi, "")
          .replace(/\b(shorts|short|trending|viral|status|full screen|4k|hd|lyrics|lyrical|video|audio)\b/gi, "")
          .trim();

        const segments = cleanRaw.split(/[|\-•]/).map(s => s.trim()).filter(s => s.length > 1);
        if (segments.length >= 2) {
          return `${segments[0]} ${segments[1]}`;
        }
        return segments[0] || cleanRaw;
      }
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

// Exports User ID Database as .txt Document
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

// Admin Broadcast Copy Engine
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
    text: `✅ *Broadcast Complete!*\n\n• 📬 *Delivered:* ${sent} users\n• 🚫 *Failed / Blocked:* ${failed} users`,
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
  text += `• 💾 *Storage Engine:* ${db ? "Permanent Cloudflare KV (`BOT_DB`)" : "⚠️ RAM Mode"}\n\n`;
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
