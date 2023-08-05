import os
import asyncio
from flask import Flask
from discord.ext import commands
import discord

intents = discord.Intents.default()
intents.guilds = True
intents.voice_states = True
intents.messages = True

client = commands.Bot(command_prefix='!', intents=intents)
app = Flask(__name__)
port = 3001
token = ""
channel_id = ""

messages = {}  # Dictionary to store message IDs
timers = {}    # Dictionary to store timers

@app.route('/status')
def status():
    return 'Herald of the Obese is running!'

def personal_message(member, channel):
    user_name = member.name
    if 'Jerkyturd' in user_name:
        return f"{user_name} has joined {channel} and is opening CSGO cases."
    elif 'icewallowpis' in user_name:
        return f"{user_name} is in {channel} being racist and homophobic."
    elif 'nathanielklump' in user_name:
        return f"{user_name} has joined {channel} and will probably be leaving in 30 min."
    elif 'acidpuddle' in user_name:
        return f"{user_name} has joined {channel} and will be lowering everyone's mental."
    elif 'dillondabeast' in user_name:
        return f"{user_name} has joined {channel} to oppress minorities and women."
    else:
        return f"{user_name} joined voice channel {channel}"

@client.event
async def on_ready():
    print(f'Ready! Logged in as {client.user.name}#{client.user.discriminator}')

@client.event
async def on_voice_state_update(member, before, after):

    # User join message
    if after.channel and member.id != client.user.id:
        print(f'{member} joined voice channel {after.channel.name}')

        # Schedule the handle_join function to run after 2 seconds
        timers[member.id] = client.loop.create_task(schedule_handle_join(member, after))

    # User leave action
    if before.channel and member.id != client.user.id:
        print(f'{member} left voice channel {before.channel.name}')

        # Cancel the join message task if it exists
        timer = timers.pop(member.id, None)
        if timer:
            timer.cancel()

        # Proceed with normal leave action
        message_id = messages.pop(member.id, None)
        if message_id:
            text_channel = client.get_channel(int(channel_id))
            if text_channel:
                message = await text_channel.fetch_message(message_id)
                if message:
                    await message.delete()

async def schedule_handle_join(member, state):
    await asyncio.sleep(2)  # Wait for 2 seconds
    await handle_join(member, state)

async def handle_join(member, state):
    timers.pop(member.id, None)
    text_channel = client.get_channel(int(channel_id))
    if text_channel:
        text = personal_message(member, state.channel.name)
        message = await text_channel.send(text)
        messages[member.id] = message.id

client.run(token)

if __name__ == '__main__':
    app.run(port=port)
