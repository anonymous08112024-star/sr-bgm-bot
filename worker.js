const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";

const SONG_CACHE = new Map();

export default {
  async fetch(request, env) {
    const botToken = (env && env.BOT_TOKEN ? env.BOT_TOKEN : DEFAULT_BOT_TOKEN).trim();
    const geminiKey = (env && env.GEMINI_KEY ? env.GEMINI_KEY : DEFAULT_GEMINI_KEY).trim();
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

      let html = `<h2>${tgData.ok ? "✅ Music Downloader Bot Live!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p>Open Telegram and type any song name to test the Top-5 Button Picker & Direct MP3 Player!</p>`;

      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const update = await request.json();
        await handleUpdate(update, botToken, geminiKey);
      } catch (err) {
        console.error("Webhook error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response(
      `🎵 Instant MP3 Music Downloader Bot is Running!\nVisit ${url.origin}/setup to verify webhook.`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

async function handleUpdate(update, botToken, geminiKey) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;
    const data = cb.data || "";

    if (data === "verify_join") {
      const joined = await isUserInChannel(botToken, userId);
      if (joined) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Verified! Send any song name now."
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "🎉 *Access Unlocked!*\n\nType any *Song Name*, *Singer Name*, *Movie Name*, or *Lyrics* below to get the playable MP3:",
          parse_mode: "Markdown"
        });
      } else {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⚠️ Please join ${CHANNEL_USERNAME} first, then tap Verify!`,
          show_alert: true
        });
      }
      return;
    }

    if (data.startsWith("dl|")) {
      await tgApi(botToken, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: "🎧 Preparing your playable MP3..."
      });

      const parts = data.split("|");
      const songId = parts[1] || "";

      let fallbackQuery = "";
      const rows = cb.message?.reply_markup?.inline_keyboard || [];
      for (const row of rows) {
        for (const btn of row) {
          if (btn.callback_data === data && btn.text) {
            fallbackQuery = btn.text.replace(/^🎵\s*\d+\.\s*/, "").trim();
          }
        }
      }

      const loadingMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⬇️ _Uploading playable MP3 track to Telegram..._",
        parse_mode: "Markdown"
      });

      let track = SONG_CACHE.get(songId);
      if (!track && songId) {
        track = await fetchSaavnSongById(songId);
      }
      if (!track && fallbackQuery) {
        const list = await searchTopSongs(fallbackQuery, 1);
        track = list[0] || null;
      }

      await sendPlayableMp3(botToken, chatId, loadingMsg.result?.message_id, track);
      return;
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.chat) return;

  const chatId = msg.chat.id;
  const userId = msg.from ? msg.from.id : chatId;
  const text = (msg.text || msg.caption || "").trim();

  const isMember = await isUserInChannel(botToken, userId);
  if (!isMember) {
    const channelHandle = CHANNEL_USERNAME.replace("@", "");
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `🔒 *Welcome to Instant MP3 Music Bot!*\n\nTo keep this bot 100% free and download unlimited 320kbps MP3 songs, please join our official channel ${CHANNEL_USERNAME} first:`,
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
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "🎵 *Instant 320kbps MP3 Music Downloader*\n\nJust type and send:\n• *Any Song Name* (e.g., _Pal Pal Dil Ke Paas_, _Kesariya_, _Blinding Lights_)\n• *Song + Singer Name* (e.g., _Tum Hi Ho Arijit Singh_)\n• *Any Line of Lyrics* or a *YouTube Link*\n\nI will show you the top matching tracks—tap any button to get the directly playable `.mp3` in chat!",
      parse_mode: "Markdown"
    });
    return;
  }

  if (!text) return;

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

  let songs = await searchTopSongs(searchQuery, 5);

  if (songs.length === 0 && geminiKey && !geminiKey.includes("PASTE_YOUR")) {
    const aiGuess = await guessSongFromLyricsWithGemini(geminiKey, text);
    if (aiGuess) {
      songs = await searchTopSongs(aiGuess, 5);
    }
  }

  if (statusMsg.result?.message_id) {
    await tgApi(botToken, "deleteMessage", {
      chat_id: chatId,
      message_id: statusMsg.result.message_id
    });
  }

  if (songs.length === 0) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "😕 *No matching songs found.*\n\nTry typing the song title along with the singer or movie name (for example: `Pal Pal Dil Ke Paas Arijit`).",
      parse_mode: "Markdown"
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
  const safeFileName = `${finalTitle} - ${finalArtist}`.replace(/[\\/:*?"<>|]/g, "").slice(0, 80) + ".mp3";
  const channelHandle = CHANNEL_USERNAME.replace("@", "");

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
      `🎵 *${escapeMd(finalTitle)}*\n🎤 ${escapeMd(finalArtist)}${track.album ? `\n💿 _${escapeMd(track.album)}_` : ""}\n\n⚡ _Downloaded via ${CHANNEL_USERNAME}_`
    );
    form.append("parse_mode", "Markdown");
    form.append(
      "reply_markup",
      JSON.stringify({
        inline_keyboard: [
          [{ text: `📢 Join ${CHANNEL_USERNAME}`, url: `https://t.me/${channelHandle}` }]
        ]
      })
    );

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
    caption: `🎵 *${escapeMd(finalTitle)}* — ${escapeMd(finalArtist)}\n⚡ _via ${CHANNEL_USERNAME}_`,
    parse_mode: "Markdown"
  });
}

async function searchTopSongs(query, limit = 5) {
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
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
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
    if (res.ok) {
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    }
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
  } catch (e) {
    return true;
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
