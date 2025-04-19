const { Client, Events, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const express = require('express');
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
        GatewayIntentBits.MessageContent
    ],
});

const messages = new Map(); // Map to store message IDs
const timers = new Map(); // Map to store timers

const PersonalMessage = (user, channel) => {
    if (user.includes('Jerkyturd')) {
      return `${user} has joined ${channel} and is opening CSGO cases.`;
    } else if (user.includes('icewallowpis')) {
      return `homosexual incoming... ${user}. ${channel}!`;
    } else if (user.includes('nathanielklump')) {
      return `${user}. gay. ${channel}.`;
    } else if (user.includes('acidpuddle')) {
        return `${user} touched down in ${channel} and will be lowering everyone's mental.`;
    } else if (user.includes('adamj3961')) {
        return `${user}. gay. ${channel}.`;
    } else if (user.includes('dillon')) {
        return `${user}. gay. ${channel}.`;
    } else {
      return `${user} joined voice channel ${channel}`;
    }
};

// Function to delete all messages sent by the bot with a 30-second time limit
async function deleteAllBotMessages() {

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
                console.log(`Time limit of 30 seconds reached. Stopping deletion process.`);
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
                    console.log(`Time limit of 30 seconds reached during deletion. Stopping.`);
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
    if (newState.channel_Id && newState.member.user.id !== client.user.id) {
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
    if (oldState.channel_Id && oldState.member.user.id !== client.user.id) {
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

client.once(Events.ClientReady, async c => {
    console.log(`Ready! Logged in as ${c.user.tag}`);
    
    // Delete all previous bot messages as the first action
    await deleteAllBotMessages();
    
    console.log('Bot is now fully operational.');
});

// Use environment variable for token, fallback to hardcoded value only for development
client.login(discord_bot_token || "N/A");

app.listen(port, () => {
    console.log(`Server is running on port: ${port}`);
});