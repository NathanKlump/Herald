const { Client, Events, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const express = require('express');

const app = express();
const port = '3001';

app.get('/status', (req, res) => {
    res.send('Herald of the Obese is running!');
});


const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates
    ], 
});

const messages = new Map(); // Map to store message IDs
const timers = new Map(); // Map to store timers

const PersonalMessage = (user, channel) => {
    
    if (user.includes('Jerkyturd')) {
      return `${user} has joined ${channel} and is opening CSGO cases.`;
    } else if (user.includes('icewallowpis')) {
      return `${user} is in ${channel} being a great guy!`;
    } else if (user.includes('nathanielklump')) {
      return `${user} has joined ${channel} and will probably be leaving in 30 min.`;
    } else if (user.includes('acidpuddle')) {
        return `${user} has joined ${channel} and will be lowering everyone's mental.`;
    } else {
      return `${user} joined voice channel ${channel}`;
    }
  };

client.on('voiceStateUpdate', async (oldState, newState) => {
    const channelId = process.env.DISCORD_CHANNEL_ID;

    // user join message
    if (newState.channelId && newState.member.user.id !== client.user.id) {
        console.log(`${newState.member.user.tag} joined voice channel ${newState.channel.name}`);

        // Start a 2-second timer for this user to send the join message
        timers.set(newState.member.user.id, setTimeout(async () => {
            timers.delete(newState.member.user.id);

            const textChannel = client.channels.cache.get(channelId);
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
            const textChannel = client.channels.cache.get(channelId);
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


client.once(Events.ClientReady, c => {
	console.log(`Ready! Logged in as ${c.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);


app.listen(port, () => {console.log(`Server is running on port: ${port}`);});
