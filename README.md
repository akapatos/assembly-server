# AUTOPILOT Assembly Server

Standalone microservice that assembles AUTOPILOT video scenes with **FFmpeg on a full Node server** (Railway, Render, Heroku, etc.). The main Next.js app on Vercel calls this service instead of running FFmpeg inside serverless functions.

## What it does

1. Accepts `POST /assemble` with scene clips and Cloudinary credentials
2. Downloads stock footage and voiceover audio for each clip
3. Trims/loops stock, scales to 1080p, and muxes voice with FFmpeg
4. Concatenates all scene segments with the FFmpeg **concat demuxer**
5. Uploads the final MP4 to Cloudinary (plain upload, no transformations)
6. Returns `{ file_url, duration }`

## API

### `POST /assemble`

**Body (JSON):**

```json
{
  "videoId": "uuid",
  "cloudinaryConfig": {
    "cloud_name": "...",
    "api_key": "...",
    "api_secret": "..."
  },
  "clips": [
    {
      "file_url": "https://...",
      "voice_url": "https://...",
      "trim_start": 0,
      "voice_duration": 8.5,
      "duration": 8.5
    }
  ]
}
```

**Response:**

```json
{
  "file_url": "https://res.cloudinary.com/.../final.mp4",
  "duration": 42.3,
  "public_id": "autopilot/<videoId>/final"
}
```

### `GET /health`

Returns `{ "ok": true }`.

## Run locally

```bash
cd ~/assembly-server
npm install
PORT=3001 npm start
```

## Deploy

Set `PORT` from the platform (most hosts inject it automatically). Example Procfile:

```
web: node index.js
```

Point the main AUTOPILOT app at this service URL for assembly (e.g. `ASSEMBLY_SERVER_URL=https://your-service.railway.app`).

## Dependencies

- **express** — HTTP server
- **fluent-ffmpeg** + **@ffmpeg-installer/ffmpeg** + **@ffprobe-installer/ffprobe** — video processing
- **cloudinary** — final upload only
- **cors** — allow requests from the Next.js app
- **node-fetch** — HTTP downloads (also uses native `fetch` when available)
