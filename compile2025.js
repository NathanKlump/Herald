require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');

ffmpeg.setFfmpegPath(ffmpegPath);

// Configuration
const CLIP_CHANNEL_1 = process.env.CLIP_CHANNEL_1;
const CLIP_CHANNEL_2 = process.env.CLIP_CHANNEL_2;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const OUTPUT_DIR = path.join(__dirname, 'compilations');

// Video file extensions to look for
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.flv', '.wmv'];

// Initialize Discord client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
});

/**
 * Fetch all messages from a channel during 2025
 */
async function fetchMessagesFrom2025(channelId) {
    console.log(`Fetching messages from channel ${channelId}...`);
    const channel = await client.channels.fetch(channelId);
    const allMessages = [];
    let lastMessageId = null;

    // 2025 date range
    const startOf2025 = new Date('2025-01-01T00:00:00Z');
    const endOf2025 = new Date('2025-12-31T23:59:59Z');

    while (true) {
        const options = { limit: 100 };
        if (lastMessageId) {
            options.before = lastMessageId;
        }

        const messages = await channel.messages.fetch(options);

        if (messages.size === 0) break;

        for (const message of messages.values()) {
            const messageDate = message.createdAt;

            // Stop if we've gone past 2025
            if (messageDate < startOf2025) {
                return allMessages;
            }

            // Only include messages from 2025
            if (messageDate >= startOf2025 && messageDate <= endOf2025) {
                allMessages.push(message);
            }
        }

        lastMessageId = messages.last().id;

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return allMessages;
}

/**
 * Filter messages that have video attachments
 */
function filterVideoMessages(messages) {
    const videoMessages = [];

    for (const message of messages) {
        if (message.attachments.size > 0) {
            for (const attachment of message.attachments.values()) {
                const ext = path.extname(attachment.name).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    videoMessages.push({
                        timestamp: message.createdAt,
                        author: message.author.tag,
                        url: attachment.url,
                        filename: attachment.name,
                        messageId: message.id
                    });
                }
            }
        }
    }

    // Sort by timestamp (chronological order)
    videoMessages.sort((a, b) => a.timestamp - b.timestamp);

    return videoMessages;
}

/**
 * Download a video from a URL
 */
async function downloadVideo(url, outputPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outputPath);

        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(outputPath, () => {});
            reject(err);
        });

        file.on('error', (err) => {
            fs.unlink(outputPath, () => {});
            reject(err);
        });
    });
}

/**
 * Download all videos
 */
async function downloadAllVideos(videoMessages, channelName) {
    console.log(`\nDownloading ${videoMessages.length} videos for ${channelName}...`);

    const channelDir = path.join(DOWNLOAD_DIR, channelName);
    if (!fs.existsSync(channelDir)) {
        fs.mkdirSync(channelDir, { recursive: true });
    }

    const downloadedVideos = [];

    for (let i = 0; i < videoMessages.length; i++) {
        const video = videoMessages[i];
        const ext = path.extname(video.filename);
        const outputPath = path.join(channelDir, `video_${i.toString().padStart(4, '0')}${ext}`);

        try {
            console.log(`  [${i + 1}/${videoMessages.length}] Downloading: ${video.filename}`);
            await downloadVideo(video.url, outputPath);
            downloadedVideos.push({
                path: outputPath,
                ...video
            });
        } catch (error) {
            console.error(`  Failed to download ${video.filename}: ${error.message}`);
        }

        // Small delay between downloads
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return downloadedVideos;
}

/**
 * Concatenate videos using FFmpeg
 */
async function concatenateVideos(videos, outputPath, channelName) {
    return new Promise((resolve, reject) => {
        if (videos.length === 0) {
            reject(new Error('No videos to concatenate'));
            return;
        }

        console.log(`\nCreating compilation for ${channelName}...`);
        console.log(`Output: ${outputPath}`);

        // Create a file list for FFmpeg concat
        const listFilePath = path.join(path.dirname(videos[0].path), 'filelist.txt');
        const fileListContent = videos.map(v => `file '${path.basename(v.path)}'`).join('\n');
        fs.writeFileSync(listFilePath, fileListContent);

        ffmpeg()
            .input(listFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c', 'copy'])
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('FFmpeg command:', commandLine);
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log(`Progress: ${progress.percent.toFixed(2)}%`);
                }
            })
            .on('end', () => {
                console.log(`Compilation complete: ${outputPath}`);
                fs.unlinkSync(listFilePath);
                resolve();
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err.message);
                if (fs.existsSync(listFilePath)) {
                    fs.unlinkSync(listFilePath);
                }
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
        console.log('Cleanup complete.');
    }
}

/**
 * Process a single channel
 */
async function processChannel(channelId, channelName) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing Channel: ${channelName}`);
    console.log('='.repeat(60));

    try {
        // Fetch messages
        const messages = await fetchMessagesFrom2025(channelId);
        console.log(`Found ${messages.length} total messages from 2025`);

        // Filter video messages
        const videoMessages = filterVideoMessages(messages);
        console.log(`Found ${videoMessages.length} video clips`);

        if (videoMessages.length === 0) {
            console.log('No videos to compile for this channel.');
            return;
        }

        // Download videos
        const downloadedVideos = await downloadAllVideos(videoMessages, channelName);

        if (downloadedVideos.length === 0) {
            console.log('No videos were successfully downloaded.');
            return;
        }

        // Create output directory
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Concatenate videos
        const outputPath = path.join(OUTPUT_DIR, `${channelName}_2025_compilation.mp4`);
        await concatenateVideos(downloadedVideos, outputPath, channelName);

        // Cleanup
        cleanupDownloads(channelName);

        console.log(`\n✓ ${channelName} compilation completed successfully!`);

    } catch (error) {
        console.error(`Error processing ${channelName}:`, error);
        // Still cleanup even if there was an error
        cleanupDownloads(channelName);
    }
}

/**
 * Main function
 */
async function main() {
    try {
        console.log('Herald Video Compilation Script - 2025 Year End');
        console.log('================================================\n');

        // Validate environment variables
        if (!CLIP_CHANNEL_1 || !CLIP_CHANNEL_2) {
            throw new Error('Please set CLIP_CHANNEL_1 and CLIP_CHANNEL_2 in your .env file');
        }

        if (!DISCORD_BOT_TOKEN) {
            throw new Error('Please set DISCORD_BOT_TOKEN in your .env file');
        }

        console.log('Logging in to Discord...');
        await client.login(DISCORD_BOT_TOKEN);
        console.log('Logged in successfully!\n');

        // Fetch messages from both channels
        console.log('='.repeat(60));
        console.log('Fetching clips from both channels...');
        console.log('='.repeat(60));

        const messages1 = await fetchMessagesFrom2025(CLIP_CHANNEL_1);
        console.log(`Channel 1: Found ${messages1.length} total messages from 2025`);

        const messages2 = await fetchMessagesFrom2025(CLIP_CHANNEL_2);
        console.log(`Channel 2: Found ${messages2.length} total messages from 2025`);

        // Filter video messages from both channels
        const videoMessages1 = filterVideoMessages(messages1);
        const videoMessages2 = filterVideoMessages(messages2);
        console.log(`Channel 1: Found ${videoMessages1.length} video clips`);
        console.log(`Channel 2: Found ${videoMessages2.length} video clips`);

        // Combine and sort all videos by timestamp
        const allVideos = [...videoMessages1, ...videoMessages2];
        allVideos.sort((a, b) => a.timestamp - b.timestamp);
        console.log(`\nTotal videos to compile: ${allVideos.length}`);

        if (allVideos.length === 0) {
            console.log('No videos found to compile.');
            await client.destroy();
            process.exit(0);
        }

        // Download all videos
        const downloadedVideos = await downloadAllVideos(allVideos, 'combined');

        if (downloadedVideos.length === 0) {
            console.log('No videos were successfully downloaded.');
            await client.destroy();
            process.exit(1);
        }

        // Create output directory
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Concatenate all videos into one compilation
        const outputPath = path.join(OUTPUT_DIR, '2025_compilation.mp4');
        await concatenateVideos(downloadedVideos, outputPath, 'Combined');

        // Cleanup
        cleanupDownloads('combined');

        console.log('\n' + '='.repeat(60));
        console.log('Compilation complete!');
        console.log(`Output: ${outputPath}`);
        console.log('='.repeat(60));

        // Logout and exit
        await client.destroy();
        process.exit(0);

    } catch (error) {
        console.error('Fatal error:', error);
        await client.destroy();
        process.exit(1);
    }
}

// Handle client ready event
client.once('ready', () => {
    console.log('Bot is ready!');
});

// Start the script
main();
