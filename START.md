# How to run PropIQ API

## Step 1 — Add your Odds API key
Open the file called `.env` in this folder (use TextEdit or any text editor).
Find the line that says:
  ODDS_API_KEY=PASTE_YOUR_KEY_HERE

Replace PASTE_YOUR_KEY_HERE with your actual key from https://the-odds-api.com

Save the file.

## Step 2 — Open Terminal
Press Cmd + Space, type Terminal, press Enter.

## Step 3 — Run these 3 commands (copy/paste each one, press Enter after each)

cd ~/Desktop/propiq-api

npm install

npm run dev

## Step 4 — It's running!
Open your browser and go to:
  http://localhost:3000/health

You should see: {"status":"ok"}

## Step 5 — Capture today's opening lines
In a NEW Terminal tab, run:
  curl -X POST http://localhost:3000/api/lines/snapshot/opening

Do this once every morning before games start.

## Useful URLs once running:
  http://localhost:3000/health                                        — check server is up
  http://localhost:3000/api/matchups                                  — today's slate
  http://localhost:3000/api/plays                                     — analyzed plays
  http://localhost:3000/api/lines/best?market=pitcher_strikeouts      — line comparison
