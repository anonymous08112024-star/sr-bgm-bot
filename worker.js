const DEFAULT_BOT_TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE";
const DEFAULT_GEMINI_KEY = "PASTE_YOUR_GEMINI_KEY_HERE";
const CHANNEL_USERNAME = "@SrBotsClub";

const MEMORY_CACHE = new Map();

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
      const geminiTest = await testGeminiKey(geminiKey);

      let html = `<h2>${tgData.ok ? "✅ Bot Webhook Connected!" : "❌ Telegram Token Error"}</h2>`;
      html += `<p><b>Telegram Status:</b> ${tgData.ok ? "Connected to " + CHANNEL_USERNAME : JSON.stringify(tgData)}</p>`;
      html += `<p><b>Gemini Audio AI Key Status:</b> ${geminiTest}</p>`;
      html += `<p>Now go to Telegram and try sending a song name, YouTube Shorts link, or Voice Note!</p>`;

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
      `🎵 BGM Identifier Bot Server is Running!\nVisit ${url.origin}/setup to check status & connect your Telegram Webhook.`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
};

async function testGeminiKey(geminiKey) {
  if (!geminiKey || geminiKey.includes("PASTE_YOUR")) {
    return "⚠️ GEMINI_KEY is not set in Runtime Variables (only in Build variables or missing). Direct song search & YouTube links will still work, but add GEMINI_KEY in the top Variables & Secrets section for Voice Note recognition!";
  }
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let lastError = "";
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: "Reply OK" }] }] })
        }
      );
      const data = await res.json();
      if (res.ok && data.candidates) {
        return `✅ Working (${model} active!)`;
      }
      lastError = data.error?.message || JSON.stringify(data);
    } catch (e) {
      lastError = e.message;
    }
  }
  return `❌ Google API Error: ${lastError}`;
}

async function handleUpdate(update, botToken, geminiKey) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const userId = cb.from.id;

    if (cb.data === "verify_join") {
      const joined = await isUserInChannel(botToken, userId);
      if (joined) {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "✅ Verified! You now have full access."
        });
        await tgApi(botToken, "sendMessage", {
          chat_id: chatId,
          text: "🎉 *Access Unlocked!*\n\nSend me any of the following to find the background song & get the playable audio:\n• 🎤 A *Voice Note* or *Audio Clip*\n• 🎬 A short *Video Clip*\n• 🔗 An *Instagram Reel* or *YouTube Shorts* link\n• 📝 Or type any *Lyrics / Song Name*",
          parse_mode: "Markdown"
        });
      } else {
        await tgApi(botToken, "answerCallbackQuery", {
          callback_query_id: cb.id,
          text: `⚠️ Please join ${CHANNEL_USERNAME} first, then tap Verify!`,
          show_alert: true
        });
      }
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
      text: `🔒 *Welcome to BGM & Song Finder Bot!*\n\nTo keep this bot 100% free and unlock instant song identification + MP3 downloads, please join our official channel ${CHANNEL_USERNAME} first:`,
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
      text: "🎵 *BGM Identifier & Full Song Bot*\n\nSend me any of these and I will find the background song + send the playable audio:\n\n1️⃣ *Voice Note / Audio File* (even with someone speaking over the music)\n2️⃣ *Video Clip* (under 15 MB)\n3️⃣ *Instagram Reel / YouTube Shorts Link*\n4️⃣ *Any Lyrics or Song Title*\n\n_Send a clip, link, or song name now to try it!_",
      parse_mode: "Markdown"
    });
    return;
  }

  if (text === "/status") {
    const geminiStatus = await testGeminiKey(geminiKey);
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: `⚙️ *Bot Diagnostic Status*\n\n• *Channel:* ${CHANNEL_USERNAME}\n• *AI Key Status:* ${escapeMd(geminiStatus)}`,
      parse_mode: "Markdown"
    });
    return;
  }

  const mediaObj = msg.voice || msg.audio || msg.video || msg.video_note || msg.document;

  if (mediaObj) {
    const metaTitle = msg.audio?.title || "";
    const metaPerformer = msg.audio?.performer || "";
    const metaFileName = (msg.audio?.file_name || msg.document?.file_name || "")
      .replace(/\.(mp3|m4a|wav|ogg|flac|mp4|mkv)$/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\(official.*?\)|\[official.*?\]|lyrics|video|audio/gi, "")
      .trim();

    const combinedMeta = `${metaPerformer} ${metaTitle}`.trim() || metaFileName;
    const isGenericFileName = /^(audio|voice|video|vid|aud|doc|file|record|clip|whatsapp|telegram)[0-9_\s-]*$/i.test(combinedMeta);

    if (combinedMeta && combinedMeta.length > 2 && !isGenericFileName && !msg.voice && !msg.video_note) {
      const statusMsg = await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "🎧 _Matching audio track details..._",
        parse_mode: "Markdown"
      });
      await deliverSongResult(botToken, chatId, statusMsg.result?.message_id, {
        identified: true,
        title: metaTitle || metaFileName,
        artist: metaPerformer || "Artist",
        search_query: combinedMeta
      });
      return;
    }

    if (mediaObj.file_size && mediaObj.file_size > 15 * 1024 * 1024) {
      await tgApi(botToken, "sendMessage", {
        chat_id: chatId,
        text: "⚠️ *File Too Large (Over 15 MB)*\n\nPlease send a shorter 10–15 second clip, record a quick voice note of the audio, or paste the Reel/Shorts link directly!",
        parse_mode: "Markdown"
      });
      return;
    }

    const statusMsg = await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "🎧 _Listening to background audio & isolating the music track..._",
      parse_mode: "Markdown"
    });

    const mediaResult = await identifyFromTelegramFile(botToken, geminiKey, mediaObj);
    await deliverSongResult(botToken, chatId, statusMsg.result?.message_id, mediaResult);
    return;
  }

  if (text) {
    const cacheKey = normalizeCacheKey(text);
    if (MEMORY_CACHE.has(cacheKey)) {
      const cached = MEMORY_CACHE.get(cacheKey);
      await deliverSongResult(botToken, chatId, null, cached);
      return;
    }

    const statusMsg = await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "🔍 _Searching & extracting song details..._",
      parse_mode: "Markdown"
    });

    const textResult = await identifyFromTextOrUrl(geminiKey, text);
    if (textResult && textResult.search_query) {
      MEMORY_CACHE.set(cacheKey, textResult);
    }
    await deliverSongResult(botToken, chatId, statusMsg.result?.message_id, textResult);
  }
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

async function identifyFromTelegramFile(botToken, geminiKey, mediaObj) {
  try {
    const fileRes = await tgApi(botToken, "getFile", { file_id: mediaObj.file_id });
    if (!fileRes.ok || !fileRes.result?.file_path) {
      return { identified: false };
    }

    const filePath = fileRes.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
    const audioResponse = await fetch(downloadUrl);
    const arrayBuffer = await audioResponse.arrayBuffer();
    const base64Audio = arrayBufferToBase64(arrayBuffer);

    let mimeType = mediaObj.mime_type || "audio/ogg";
    if (filePath.endsWith(".mp4")) mimeType = "video/mp4";
    else if (filePath.endsWith(".mp3")) mimeType = "audio/mp3";
    else if (filePath.endsWith(".ogg") || filePath.endsWith(".oga")) mimeType = "audio/ogg";

    const prompt = `You are an expert music & BGM recognition engine (like Shazam).
Listen carefully to this clip. Even if someone is talking in the foreground, focus on:
1. Any background music (BGM), melody, beat, or instrumental hook.
2. Any audible sung lyrics (in Hindi, English, Punjabi, Tamil, Spanish, or any language).
3. Any recognizable movie dialogue or viral audio trend.

Return ONLY a raw JSON object (no markdown formatting) with these exact fields:
{
  "identified": true,
  "title": "Exact Song Name",
  "artist": "Singer / Composer / Movie Name",
  "lyrics_heard": "Short snippet of lyrics or description heard",
  "confidence": "High / Medium",
  "search_query": "Song Name Artist Name"
}
If there is truly zero recognizable song or lyrics, return {"identified": false, "lyrics_heard": "", "search_query": ""}.`;

    const parts = [
      { text: prompt },
      { inline_data: { mime_type: mimeType, data: base64Audio } }
    ];

    return await callGeminiJson(geminiKey, parts);
  } catch (err) {
    return { identified: false };
  }
}

async function identifyFromTextOrUrl(geminiKey, text) {
  let metadataContext = "";
  let rawVideoTitle = "";
  let rawAuthor = "";
  const urlMatch = text.match(/https?:\/\/[^\s]+/i);

  if (urlMatch) {
    const targetUrl = urlMatch[0];
    const ytIdMatch = targetUrl.match(/(?:shorts\/|v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    const lookupUrl = ytIdMatch
      ? `https://www.youtube.com/watch?v=${ytIdMatch[1]}`
      : targetUrl;

    const oembedEndpoints = [
      `https://www.youtube.com/oembed?url=${encodeURIComponent(lookupUrl)}&format=json`,
      `https://noembed.com/embed?url=${encodeURIComponent(lookupUrl)}`
    ];

    for (const ep of oembedEndpoints) {
      try {
        const oembedRes = await fetch(ep);
        if (oembedRes.ok) {
          const oembed = await oembedRes.json();
          if (oembed.title) {
            rawVideoTitle = oembed.title;
            rawAuthor = oembed.author_name || "";
            metadataContext += `Video Title: ${oembed.title} | Channel: ${rawAuthor}\n`;
            break;
          }
        }
      } catch (e) {}
    }

    if (!rawVideoTitle) {
      try {
        const pageRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
          }
        });
        if (pageRes.ok) {
          const html = (await pageRes.text()).slice(0, 30000);
          const titleMatch =
            html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
            html.match(/<title[^>]*>([^<]+)<\/title>/i);
          const descMatch =
            html.match(/property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
            html.match(/name=["']description["']\s+content=["']([^"']+)["']/i);
          const audioMatch = html.match(/audio_title["']?\s*:\s*["']([^"']+)["']/i);
          if (titleMatch) {
            rawVideoTitle = cleanHtmlEntities(titleMatch[1]);
            metadataContext += `Page Title: ${rawVideoTitle}\n`;
          }
          if (descMatch) metadataContext += `Description: ${cleanHtmlEntities(descMatch[1])}\n`;
          if (audioMatch) metadataContext += `Audio Tag: ${cleanHtmlEntities(audioMatch[1])}\n`;
        }
      } catch (e) {}
    }

    if (!metadataContext.trim()) {
      return { identified: false, is_private_reel: true };
    }
  }

  const prompt = `You are a music identification expert. Based on the user input and extracted link metadata below, identify the most likely song title and artist.
User Input: ${text}
Extracted Link Metadata: ${metadataContext || "Direct text/lyrics search"}

Return ONLY a raw JSON object (no markdown formatting):
{
  "identified": true,
  "title": "Exact Song Name",
  "artist": "Artist or Movie Name",
  "lyrics_heard": "",
  "confidence": "High",
  "search_query": "Exact Song Name Artist"
}`;

  const aiResult = await callGeminiJson(geminiKey, [{ text: prompt }]);
  if (aiResult && (aiResult.identified || aiResult.search_query)) {
    return aiResult;
  }

  if (rawVideoTitle) {
    const cleanedTitle = cleanVideoTitleForSongSearch(rawVideoTitle);
    if (cleanedTitle) {
      return {
        identified: true,
        title: cleanedTitle,
        artist: rawAuthor || "YouTube Audio",
        search_query: cleanedTitle
      };
    }
  }

  if (!urlMatch && text.length >= 2) {
    return {
      identified: true,
      title: text,
      artist: "",
      search_query: text
    };
  }

  return { identified: false };
}

function cleanVideoTitleForSongSearch(title) {
  return title
    .replace(/#[^\s#]+/g, "")
    .replace(/\(official.*?\)|\[official.*?\]/gi, "")
    .replace(/\b(shorts|short|trending|viral|status|whatsapp|reels|reel|bgm|ringtone|full screen|4k|hd|lyrics|lyrical|video|audio)\b/gi, "")
    .replace(/[|•~_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function callGeminiJson(geminiKey, parts) {
  if (!geminiKey || geminiKey.includes("PASTE_YOUR")) {
    return { identified: false };
  }
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { temperature: 0.1 }
          })
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {}
  }
  return { identified: false };
}

async function deliverSongResult(botToken, chatId, statusMsgId, info) {
  if (statusMsgId) {
    await tgApi(botToken, "deleteMessage", { chat_id: chatId, message_id: statusMsgId });
  }

  if (info && info.is_private_reel) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "🔒 *Instagram Hid the Audio Tag on This Reel*\n\nTo identify the background music on this specific Reel:\n1️⃣ Tap the *Microphone icon* in Telegram and record 8–10 seconds of the Reel playing, OR\n2️⃣ Send the short video/audio clip directly here!\n\n_I will listen to the audio directly and pull the song for you._",
      parse_mode: "Markdown"
    });
    return;
  }

  if (!info || (!info.identified && !info.search_query)) {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: "😕 *Could Not Catch That Track*\n\nTry sending a clearer 10-second audio clip where the music or chorus is audible, or type a few words of the lyrics!",
      parse_mode: "Markdown"
    });
    return;
  }

  const query = info.search_query || `${info.title || ""} ${info.artist || ""}`.trim();
  const trackData = await fetchFullSongFromCdn(query);

  const finalTitle = trackData?.title || info.title || query;
  const finalArtist = trackData?.artist || info.artist || "Artist";
  const ytSearchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(finalTitle + " " + finalArtist)}`;
  const spotifySearchUrl = `https://open.spotify.com/search/${encodeURIComponent(finalTitle + " " + finalArtist)}`;
  const channelHandle = CHANNEL_USERNAME.replace("@", "");

  let caption = `🎵 *Song Identified!*\n\n`;
  caption += `📌 *Title:* ${escapeMd(finalTitle)}\n`;
  caption += `🎤 *Artist:* ${escapeMd(finalArtist)}\n`;
  if (trackData?.album) caption += `💿 *Album:* ${escapeMd(trackData.album)}\n`;
  if (info.lyrics_heard) caption += `💬 *Matched Audio:* _"${escapeMd(info.lyrics_heard)}"_\n`;
  caption += `\n⚡ _Powered by ${CHANNEL_USERNAME}_`;

  const buttons = {
    inline_keyboard: [
      [
        { text: "▶️ Watch on YouTube", url: ytSearchUrl },
        { text: "🎧 Spotify", url: spotifySearchUrl }
      ],
      [{ text: `📢 Join ${CHANNEL_USERNAME}`, url: `https://t.me/${channelHandle}` }]
    ]
  };

  if (trackData?.image) {
    await tgApi(botToken, "sendPhoto", {
      chat_id: chatId,
      photo: trackData.image,
      caption: caption,
      parse_mode: "Markdown",
      reply_markup: buttons
    });
  } else {
    await tgApi(botToken, "sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "Markdown",
      reply_markup: buttons
    });
  }

  if (trackData?.audioUrl) {
    await tgApi(botToken, "sendAudio", {
      chat_id: chatId,
      audio: trackData.audioUrl,
      title: finalTitle,
      performer: finalArtist,
      caption: `🎧 *${escapeMd(finalTitle)}* — ${escapeMd(finalArtist)}\n_via ${CHANNEL_USERNAME}_`,
      parse_mode: "Markdown"
    });
  }
}

async function fetchFullSongFromCdn(query) {
  const saavnEndpoints = [
    `https://saavn.dev/api/search/songs?query=${encodeURIComponent(query)}&limit=1`,
    `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}&limit=1`,
    `https://saavnapi-nine.vercel.app/result/?query=${encodeURIComponent(query)}`,
    `https://jiosaavn-api-lemon.vercel.app/result/?query=${encodeURIComponent(query)}`
  ];

  for (const endpoint of saavnEndpoints) {
    try {
      const res = await fetch(endpoint);
      if (!res.ok) continue;
      const json = await res.json();
      const results = Array.isArray(json)
        ? json
        : (json.data?.results || json.results || []);

      if (results.length > 0) {
        const song = results[0];
        const downloads = song.downloadUrl || song.download_url || [];
        let bestAudio = null;
        if (Array.isArray(downloads) && downloads.length > 0) {
          bestAudio = downloads[downloads.length - 1]?.url || downloads[downloads.length - 1]?.link;
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

        if (bestAudio) {
          return {
            title: cleanHtmlEntities(song.name || song.title || song.song || ""),
            artist: cleanHtmlEntities(
              song.artists?.primary?.map(a => a.name).join(", ") ||
              song.primaryArtists ||
              song.singers ||
              ""
            ),
            album: cleanHtmlEntities(song.album?.name || song.album || ""),
            image: bestImage,
            audioUrl: bestAudio
          };
        }
      }
    } catch (e) {}
  }

  try {
    const itunesRes = await fetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=1`
    );
    if (itunesRes.ok) {
      const itunesData = await itunesRes.json();
      if (itunesData.results && itunesData.results.length > 0) {
        const item = itunesData.results[0];
        return {
          title: item.trackName,
          artist: item.artistName,
          album: item.collectionName,
          image: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : null,
          audioUrl: item.previewUrl || null
        };
      }
    }
  } catch (e) {}

  return null;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function normalizeCacheKey(text) {
  return text.toLowerCase().replace(/\?.*$/, "").trim();
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
