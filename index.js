const { Client, Events, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const port = '3001';

app.get('/status', (req, res) => {
    res.send('Herald of the Obese is running!');
});

const channel_Id = process.env.CHANNEL_ID;
const discord_bot_token = process.env.DISCORD_BOT_TOKEN;
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ],
    // Reactions and their messages can arrive before the bot has cached them.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const messages = new Map(); // Map to store message IDs
const timers = new Map(); // Map to store timers

// ---------------------------------------------------------------------------
// Clip approvals
//
// Requires View Channel + Read Message History in source channels and
// Send Messages + Attach Files in the approved clips channel.
// ---------------------------------------------------------------------------

// Where approved clips are copied. Override with APPROVED_CLIPS_CHANNEL_ID.
const approvedClipsChannelId = process.env.APPROVED_CLIPS_CHANNEL_ID || '948790090593878016';

// Optional comma-separated list of custom emoji IDs that should also count as
// a green checkmark (useful for server-specific checkmark emojis).
const approvedClipEmojiIds = new Set(
    (process.env.APPROVED_CLIP_EMOJI_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);

// Optional: restrict which channels can produce approved clips. By default any
// channel with a video attachment is allowed. Set CLIP_SOURCE_CHANNEL_IDS to a
// comma-separated list (for example, your clip channels) to narrow this down.
const clipSourceChannelIds = new Set(
    (process.env.CLIP_SOURCE_CHANNEL_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean)
);

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.flv', '.wmv', '.m4v']);
const VIDEO_CONTENT_TYPE_EXTENSIONS = new Map([
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/x-msvideo', '.avi'],
    ['video/x-matroska', '.mkv'],
    ['video/x-flv', '.flv'],
    ['video/x-ms-wmv', '.wmv'],
    ['video/x-m4v', '.m4v'],
]);
const CHECKMARK_EMOJIS = new Set(['✅', '✔', '☑', '✓']);
const CHECKMARK_EMOJI_NAME = /^(?:(?:green|white)[ _-]?)?(?:check[ _-]?mark|tick[ _-]?mark|check|tick|approved?)$/i;

// In-memory copy history so spam and multiple approvals only copy once.
// This intentionally resets when the bot restarts.
const MAX_COPIED_CLIP_RECORDS = 5000;
// Clips larger than this are forwarded instead of re-uploaded.
const MAX_CLIP_UPLOAD_BYTES = Number(process.env.MAX_CLIP_UPLOAD_BYTES) || 50 * 1024 * 1024;
const CLIP_DOWNLOAD_TIMEOUT_MS = 120000;
const copiedClips = new Map(); // source message ID -> copy record
const clipsInProgress = new Set(); // source message IDs currently being copied

// Serialize copies so a reaction spam cannot burst Discord's rate limits or
// upload several large videos at once.
let clipCopyQueue = Promise.resolve();

function enqueueClipCopy(task) {
    const result = clipCopyQueue.then(task);
    clipCopyQueue = result.catch(() => {});
    return result;
}

function isGreenCheckmark(emoji) {
    if (!emoji) return false;

    if (emoji.id && approvedClipEmojiIds.has(emoji.id)) return true;

    // Strip the emoji variation selector so ✅ / ✔️ / ☑️ / ✓ all match.
    const name = (emoji.name || '').replace(/\uFE0F/g, '');
    if (CHECKMARK_EMOJIS.has(name)) return true;

    // Custom emojis only match when their name clearly means "check".
    return Boolean(emoji.id && name && CHECKMARK_EMOJI_NAME.test(name));
}

function getAttachmentName(attachment) {
    if (attachment.name) return attachment.name;

    const urlPath = (attachment.url || '').split('?')[0];
    const contentType = (attachment.contentType || '').toLowerCase();
    const ext = path.extname(urlPath) || VIDEO_CONTENT_TYPE_EXTENSIONS.get(contentType) || '.mp4';
    return `clip${ext}`;
}

function isVideoAttachment(attachment) {
    if (attachment.contentType && attachment.contentType.toLowerCase().startsWith('video/')) return true;

    const source = attachment.name || (attachment.url || '').split('?')[0];
    if (!source) return false;

    const ext = path.extname(source).toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
}

function recordCopiedClip(record) {
    copiedClips.set(record.sourceMessageId, record);

    // Keep memory bounded; old approvals are very unlikely to be replayed.
    while (copiedClips.size > MAX_COPIED_CLIP_RECORDS) {
        copiedClips.delete(copiedClips.keys().next().value);
    }
}

async function buildUploadAttachment(attachment) {
    const name = getAttachmentName(attachment);

    if (attachment.size && attachment.size > MAX_CLIP_UPLOAD_BYTES) {
        throw new Error(`Clip ${name} is too large to re-upload (${attachment.size} bytes)`);
    }

    // discord.js's URL resolver does not check the HTTP status, so download
    // explicitly to avoid uploading an expired-link error page as a "clip".
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLIP_DOWNLOAD_TIMEOUT_MS);

    try {
        const response = await fetch(attachment.url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Failed to download ${name}: HTTP ${response.status}`);
        }

        const contentType = (response.headers.get('content-type') || '').toLowerCase();
        if (contentType.startsWith('text/html') || contentType.startsWith('application/json')) {
            throw new Error(`Expected a video but received ${contentType}`);
        }

        const data = Buffer.from(await response.arrayBuffer());
        if (data.length === 0) {
            throw new Error(`Downloaded ${name} was empty`);
        }
        if (data.length > MAX_CLIP_UPLOAD_BYTES) {
            throw new Error(`Downloaded ${name} is too large to re-upload (${data.length} bytes)`);
        }

        return new AttachmentBuilder(data, {
            name,
            description: attachment.description || undefined,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function copyClipToApprovedChannel(message, approvedBy) {
    let targetChannel = client.channels.cache.get(approvedClipsChannelId);
    if (!targetChannel || typeof targetChannel.send !== 'function') {
        targetChannel = await client.channels.fetch(approvedClipsChannelId);
    }

    if (!targetChannel || typeof targetChannel.send !== 'function') {
        throw new Error(`Approved clips channel ${approvedClipsChannelId} is not a text-based channel.`);
    }

    const videos = [...message.attachments.values()].filter(isVideoAttachment);
    if (videos.length === 0) {
        throw new Error(`Message ${message.id} no longer has any video attachments.`);
    }

    const header = [
        `**Approved clip** — approved by ${approvedBy.username}`,
        `Originally posted by ${message.author.username} in <#${message.channelId}>`,
        message.url,
    ].join('\n');

    try {
        // Guard against a single message with many large videos exhausting
        // memory. Oversized messages still get archived via forwarding below.
        const totalSize = videos.reduce((sum, attachment) => sum + (attachment.size || 0), 0);
        if (totalSize > MAX_CLIP_UPLOAD_BYTES) {
            throw new Error(`Clip message is too large to re-upload (${totalSize} bytes)`);
        }

        const files = [];
        for (const attachment of videos) {
            files.push(await buildUploadAttachment(attachment));
        }

        return await targetChannel.send({ content: header, files });
    } catch (error) {
        // Re-uploading fails for clips above the guild's upload limit. Forwarding
        // keeps the clip viewable in the archive channel without re-uploading it.
        console.warn(`Re-upload failed for clip ${message.id}, falling back to forwarding: ${error.message}`);
        return await message.forward(targetChannel);
    }
}

const PersonalMessage = (user, channel) => {
    if (user.includes('Jerkyturd')) {
      return `${user} has joined ${channel} and is opening CSGO cases.`;
    } else if (user.includes('icewallowpis')) {
      return `${user} is daydrinking in ${channel}!`;
    } else if (user.includes('nathanielklump')) {
      return `${user}, being the best gentile he can be. ${channel}.`;
    } else if (user.includes('acidpuddle')) {
        return `${user} touched down in ${channel} and will be lowering everyone's mental.`;
    } else if (user.includes('adamj3961')) {
        return `${user}. gay. ${channel}.`;
    } else if (user.includes('dillon')) {
        return `${user}. homosexual incoming... ${channel}.`;
    } else {
      return `${user} joined voice channel ${channel}`;
    }
};

// Function to delete all messages sent by the bot with a 30-second time limit
async function deleteAllBotMessages() {
    if (channel_Id === approvedClipsChannelId) {
        console.log('Skipping startup cleanup because CHANNEL_ID points at the approved clips channel.');
        return;
    }

    const textChannel = client.channels.cache.get(channel_Id);
    if (!textChannel) {
        console.log('Target channel not found.');
        return;
    }
    
    let deletedCount = 0;
    let lastId = null;
    const startTime = Date.now();
    const timeLimit = 5000;
    
    console.log(`Starting to delete previous bot messages (${timeLimit/1000}-second time limit)...`);
    
    
    try {
        while (Date.now() - startTime < timeLimit) {
            // Check if we've exceeded the time limit
            if (Date.now() - startTime >= timeLimit) {
                console.log(`Time limit of ${timeLimit/1000} seconds reached. Stopping deletion process.`);
                break;
            }
            
            const options = { limit: 100 };
            if (lastId) {
                options.before = lastId;
            }
            
            const messages = await textChannel.messages.fetch(options);
            if (messages.size === 0) {
                console.log('No more messages to process.');
                break;
            }
            
            // Update lastId for pagination
            lastId = messages.last().id;
            
            // Filter for messages sent by our bot
            const botMessages = messages.filter(msg => msg.author.id === client.user.id);
            if (botMessages.size === 0) continue;
            
            // Delete each message
            for (const [id, message] of botMessages) {
                // Check time limit before each deletion
                if (Date.now() - startTime >= timeLimit) {
                    console.log(`Time limit of ${timeLimit/1000} seconds reached during deletion. Stopping.`);
                    break;
                }
                
                await message.delete().catch(console.error);
                deletedCount++;
            }
            
            console.log(`Deleted ${deletedCount} messages so far... (${((Date.now() - startTime)/1000).toFixed(1)}s elapsed)`);
            
            // If we got less than 100 messages, we're probably at the end
            if (messages.size < 100) {
                console.log('Reached end of available messages.');
                break;
            }
        }
        
        const timeElapsed = ((Date.now() - startTime)/1000).toFixed(1);
        console.log(`Finished deleting bot messages. Total deleted: ${deletedCount} in ${timeElapsed}s`);
    } catch (error) {
        console.error('Error while deleting messages:', error);
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    // user join message
    if (newState.channelId && newState.member.user.id !== client.user.id) {
        console.log(`${newState.member.user.tag} joined voice channel ${newState.channel.name}`);
        // Start a 2-second timer for this user to send the join message
        timers.set(newState.member.user.id, setTimeout(async () => {
            timers.delete(newState.member.user.id);
            const textChannel = client.channels.cache.get(channel_Id);
            if (textChannel) {
                let text = PersonalMessage(newState.member.user.tag, newState.channel.name);
                const message = await textChannel.send(text);
                messages.set(newState.member.user.id, message.id);
            }
        }, 2000));
    }
    // user leave action
    if (oldState.channelId && oldState.member.user.id !== client.user.id) {
        console.log(`${oldState.member.user.tag} left voice channel ${oldState.channel.name}`);
        // If the user leaves within 2 seconds, clear the join message timer
        const timer = timers.get(oldState.member.user.id);
        if (timer) {
            clearTimeout(timer);
            timers.delete(oldState.member.user.id);
        }
        // Proceed with normal leave action
        const messageId = messages.get(oldState.member.user.id);
        if (messageId) {
            const textChannel = client.channels.cache.get(channel_Id);
            if (textChannel) {
                const message = await textChannel.messages.fetch(messageId);
                if (message) {
                    message.delete();
                    messages.delete(oldState.member.user.id);
                }
            }
        }
    }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
    let messageId;
    let reserved = false;
    let enqueued = false;

    try {
        if (user.bot || !isGreenCheckmark(reaction.emoji)) return;

        const reactionMessage = reaction.message;
        messageId = reactionMessage?.id;
        if (!messageId) return;

        // One copy per source message. Checking this before any fetch means a
        // checkmark spam cannot trigger parallel fetches for the same clip.
        if (copiedClips.has(messageId) || clipsInProgress.has(messageId)) return;

        // Filter unrelated channels before fetching anything.
        if (reactionMessage.channelId) {
            if (reactionMessage.channelId === approvedClipsChannelId) return;
            if (clipSourceChannelIds.size > 0 && !clipSourceChannelIds.has(reactionMessage.channelId)) return;
        }

        // Reserve synchronously so concurrent reactions from several people
        // cannot all start copying the same clip.
        clipsInProgress.add(messageId);
        reserved = true;

        // Reaction events can reference reactions/messages the bot has not cached.
        if (reaction.partial) {
            await reaction.fetch();
        }

        let message = reaction.message;
        if (!message || !message.id) return;

        if (message.partial) {
            message = await message.fetch();
        }

        if (!message.inGuild()) return;
        if (message.channelId === approvedClipsChannelId) return;
        if (clipSourceChannelIds.size > 0 && !clipSourceChannelIds.has(message.channelId)) return;

        const hasVideo = [...message.attachments.values()].some(isVideoAttachment);
        if (!hasVideo) return;

        const copyPromise = enqueueClipCopy(async () => {
            try {
                const copiedMessage = await copyClipToApprovedChannel(message, user);

                recordCopiedClip({
                    sourceMessageId: message.id,
                    sourceChannelId: message.channelId,
                    targetChannelId: approvedClipsChannelId,
                    copiedMessageId: copiedMessage.id,
                    approvedBy: user.id,
                    copiedAt: new Date().toISOString(),
                });

                console.log(`Copied clip ${message.id} to approved clips channel ${approvedClipsChannelId}.`);
            } finally {
                clipsInProgress.delete(message.id);
            }
        });
        enqueued = true;
        await copyPromise;
    } catch (error) {
        console.error('Failed to process clip approval reaction:', error);
    } finally {
        // Only release our own reservation, and only if the copy was never
        // handed to the queue; otherwise the queued task releases it when done.
        if (reserved && messageId && !enqueued) clipsInProgress.delete(messageId);
    }
});

client.once(Events.ClientReady, async c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    console.log(
        `Clip approvals enabled: watching ${
            clipSourceChannelIds.size ? [...clipSourceChannelIds].join(', ') : 'all channels'
        }, copying to ${approvedClipsChannelId}.`
    );

    // Delete all previous bot messages as the first action
    await deleteAllBotMessages();
    
    console.log('Bot is now fully operational.');
});

// Use environment variable for token, fallback to hardcoded value only for development
client.login(discord_bot_token || "N/A");

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
});