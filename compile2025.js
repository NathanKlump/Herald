require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const fs = require("fs");
const path = require("path");
const https = require("https");

ffmpeg.setFfmpegPath(ffmpegPath);

// Configuration
const CLIP_CHANNEL_1 = process.env.CLIP_CHANNEL_1;
const CLIP_CHANNEL_2 = process.env.CLIP_CHANNEL_2;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const DOWNLOAD_DIR = path.join(__dirname, "downloads");
const OUTPUT_DIR = path.join(__dirname, "compilations");
const ASSETS_DIR = path.join(__dirname, "assets");
const TRANSITION_PATH = path.join(ASSETS_DIR, "transition.mp4");

// Video file extensions to look for
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".avi", ".mkv", ".flv", ".wmv"];

// Normalization target (safe defaults)
const TARGET_W = 1280;
const TARGET_H = 720;
const TARGET_FPS = 24;
const AUDIO_RATE = 48000;

// Initialize Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/**
 * Fetch all messages from a channel during 2025
 */
async function fetchMessagesFrom2025(channelId) {
  console.log(`Fetching messages from channel ${channelId}...`);
  const channel = await client.channels.fetch(channelId);
  const allMessages = [];
  let lastMessageId = null;

  const startOf2025 = new Date("2025-01-01T00:00:00Z");
  const endOf2025 = new Date("2025-12-31T23:59:59Z");

  while (true) {
    const options = { limit: 100 };
    if (lastMessageId) options.before = lastMessageId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    for (const message of messages.values()) {
      const messageDate = message.createdAt;

      if (messageDate < startOf2025) return allMessages; // we paged past 2025
      if (messageDate >= startOf2025 && messageDate <= endOf2025) allMessages.push(message);
    }

    lastMessageId = messages.last().id;
    await new Promise((resolve) => setTimeout(resolve, 1000)); // avoid rate limiting
  }

  return allMessages;
}

/**
 * Filter messages that have video attachments
 */
function filterVideoMessages(messages) {
  const videoMessages = [];

  for (const message of messages) {
    if (!message.attachments?.size) continue;

    for (const attachment of message.attachments.values()) {
      const ext = path.extname(attachment.name || "").toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) continue;

      videoMessages.push({
        timestamp: message.createdAt,
        author: message.author?.tag ?? "unknown",
        url: attachment.url,
        filename: attachment.name ?? `clip${ext}`,
        messageId: message.id,
      });
    }
  }

  videoMessages.sort((a, b) => a.timestamp - b.timestamp);
  return videoMessages;
}

/**
 * Download a video from a URL
 */
async function downloadVideo(url, outputPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);

    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });

    file.on("error", (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Download all videos
 */
async function downloadAllVideos(videoMessages, channelName) {
  console.log(`\nDownloading ${videoMessages.length} videos for ${channelName}...`);

  const channelDir = path.join(DOWNLOAD_DIR, channelName);
  const rawDir = path.join(channelDir, "raw");
  const normDir = path.join(channelDir, "norm");

  ensureDir(rawDir);
  ensureDir(normDir);

  const downloadedVideos = [];

  for (let i = 0; i < videoMessages.length; i++) {
    const video = videoMessages[i];
    const ext = path.extname(video.filename) || ".mp4";
    const rawPath = path.join(rawDir, `raw_${i.toString().padStart(5, "0")}${ext}`);

    try {
      console.log(`  [${i + 1}/${videoMessages.length}] Downloading: ${video.filename}`);
      await downloadVideo(video.url, rawPath);
      downloadedVideos.push({
        rawPath,
        ...video,
      });
    } catch (error) {
      console.error(`  Failed to download ${video.filename}: ${error.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return { downloadedVideos, normDir, channelDir };
}

/**
 * Normalize a single clip to a consistent format so concat won't break.
 */
async function normalizeClip(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Make everything same resolution + CFR + audio rate/layout
    const vf = [
      `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease`,
      `pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${TARGET_FPS}`,
    ].join(",");

    ffmpeg()
      .input(inputPath)
      .inputOptions([
        "-fflags", "+genpts",
        "-err_detect", "ignore_err",
      ])
      .videoFilters(vf)
      .outputOptions([
        // video
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-crf", "20",
        // audio
        "-c:a", "aac",
        "-ar", String(AUDIO_RATE),
        "-ac", "2",
        "-b:a", "192k",
        // container flags
        "-movflags", "+faststart",
      ])
      .output(outputPath)
      .on("end", resolve)
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Normalize all downloaded videos (and optional transition) to a uniform format.
 */
async function normalizeAll(downloadedVideos, normDir) {
  console.log(`\nNormalizing ${downloadedVideos.length} clips...`);
  const normalized = [];

  for (let i = 0; i < downloadedVideos.length; i++) {
    const src = downloadedVideos[i].rawPath;
    const out = path.join(normDir, `clip_${i.toString().padStart(5, "0")}.mp4`);

    try {
      console.log(`  [${i + 1}/${downloadedVideos.length}] Normalizing ${path.basename(src)}`);
      await normalizeClip(src, out);
      normalized.push({ path: out, ...downloadedVideos[i] });
    } catch (e) {
      console.error(`  Failed to normalize ${path.basename(src)}: ${e.message}`);
    }
  }

  return normalized;
}

/**
 * Normalize transition to match the same target format (if it exists).
 */
async function normalizeTransition(normDir) {
  if (!fs.existsSync(TRANSITION_PATH)) return null;

  const out = path.join(normDir, "__transition__.mp4");
  try {
    console.log(`\nNormalizing transition: ${TRANSITION_PATH}`);
    await normalizeClip(TRANSITION_PATH, out);
    return out;
  } catch (e) {
    console.warn(`Transition exists but failed to normalize, skipping transitions: ${e.message}`);
    return null;
  }
}

/**
 * Create concat list file with absolute paths.
 */
function writeConcatListFile(items, listFilePath) {
  // concat demuxer requires: file '/abs/path'
  const lines = items.map((p) => `file '${p.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listFilePath, lines.join("\n"));
}

/**
 * Concatenate videos safely (everything already normalized).
 */
async function concatenateNormalizedVideos(normalizedVideos, outputPath, channelName, transitionNormPath) {
  return new Promise((resolve, reject) => {
    if (normalizedVideos.length === 0) {
      reject(new Error("No normalized videos to concatenate"));
      return;
    }

    console.log(`\nCreating compilation for ${channelName}...`);
    console.log(`Output: ${outputPath}`);

    const listFilePath = path.join(path.dirname(normalizedVideos[0].path), "concat_filelist.txt");
    const files = [];

    for (let i = 0; i < normalizedVideos.length; i++) {
      files.push(normalizedVideos[i].path);
      if (transitionNormPath && i < normalizedVideos.length - 1) {
        files.push(transitionNormPath);
      }
    }

    writeConcatListFile(files, listFilePath);

    ffmpeg()
      .input(listFilePath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      // Now -c copy is safe because everything matches
      .outputOptions(["-c", "copy", "-movflags", "+faststart"])
      .output(outputPath)
      .on("start", (cmd) => console.log("FFmpeg command:", cmd))
      .on("end", () => {
        console.log(`Compilation complete: ${outputPath}`);
        try { fs.unlinkSync(listFilePath); } catch {}
        resolve();
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err.message);
        try { fs.unlinkSync(listFilePath); } catch {}
        reject(err);
      })
      .run();
  });
}

/**
 * Clean up downloaded videos
 */
function cleanupDownloads(channelName) {
  const channelDir = path.join(DOWNLOAD_DIR, channelName);
  if (fs.existsSync(channelDir)) {
    console.log(`\nCleaning up downloads for ${channelName}...`);
    fs.rmSync(channelDir, { recursive: true, force: true });
    console.log("Cleanup complete.");
  }
}

/**
 * Process and compile combined channels
 */
async function processCombinedChannels() {
  console.log("Fetching clips from both channels...");

  const messages1 = await fetchMessagesFrom2025(CLIP_CHANNEL_1);
  console.log(`Channel 1: Found ${messages1.length} total messages from 2025`);

  const messages2 = await fetchMessagesFrom2025(CLIP_CHANNEL_2);
  console.log(`Channel 2: Found ${messages2.length} total messages from 2025`);

  const videoMessages1 = filterVideoMessages(messages1);
  const videoMessages2 = filterVideoMessages(messages2);

  console.log(`Channel 1: Found ${videoMessages1.length} video clips`);
  console.log(`Channel 2: Found ${videoMessages2.length} video clips`);

  const allVideos = [...videoMessages1, ...videoMessages2].sort((a, b) => a.timestamp - b.timestamp);
  console.log(`\nTotal videos to compile: ${allVideos.length}`);

  if (allVideos.length === 0) {
    console.log("No videos found to compile.");
    return;
  }

  const { downloadedVideos, normDir } = await downloadAllVideos(allVideos, "combined");

  if (downloadedVideos.length === 0) {
    console.log("No videos were successfully downloaded.");
    return;
  }

  // Normalize clips
  const normalizedVideos = await normalizeAll(downloadedVideos, normDir);

  if (normalizedVideos.length === 0) {
    console.log("No videos were successfully normalized.");
    return;
  }

  // Normalize transition (optional)
  const transitionNormPath = await normalizeTransition(normDir);
  if (transitionNormPath) console.log("✓ Transitions enabled (normalized).");
  else console.log("⚠ Transitions disabled.");

  ensureDir(OUTPUT_DIR);
  const outputPath = path.join(OUTPUT_DIR, "2025_compilation.mp4");

  await concatenateNormalizedVideos(normalizedVideos, outputPath, "Combined", transitionNormPath);

  // Cleanup raw/norm downloads
  cleanupDownloads("combined");

  console.log("\nCompilation complete!");
  console.log(`Output: ${outputPath}`);
}

/**
 * Main function
 */
async function main() {
  try {
    console.log("Herald Video Compilation Script - 2025 Year End");
    console.log("================================================\n");

    if (!CLIP_CHANNEL_1 || !CLIP_CHANNEL_2) throw new Error("Please set CLIP_CHANNEL_1 and CLIP_CHANNEL_2 in your .env file");
    if (!DISCORD_BOT_TOKEN) throw new Error("Please set DISCORD_BOT_TOKEN in your .env file");

    console.log("Logging in to Discord...");
    await client.login(DISCORD_BOT_TOKEN);
    console.log("Logged in successfully!\n");

    await processCombinedChannels();

    await client.destroy();
    process.exit(0);
  } catch (error) {
    console.error("Fatal error:", error);
    try { await client.destroy(); } catch {}
    process.exit(1);
  }
}

client.once("ready", () => console.log("Bot is ready!"));
main();
