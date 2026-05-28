import cors from "cors";
import express from "express";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import os from "os";
import path from "path";
import fetch from "node-fetch";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function getClipDuration(clip) {
  return Number(
    clip.voice_duration ??
      clip.actual_voice_duration ??
      clip.duration ??
      clip.trim_end ??
      10,
  );
}

/** Log exact FFmpeg CLI and stderr for Railway debugging. */
function attachFfmpegLogging(command) {
  return command
    .on("start", (cmd) => console.log("[ffmpeg-cmd]", cmd))
    .on("stderr", (line) => console.log("[ffmpeg-stderr]", line));
}

function probeMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      const duration = Number(metadata?.format?.duration);
      if (!duration || Number.isNaN(duration)) {
        reject(new Error(`Could not read duration for ${filePath}`));
        return;
      }
      resolve(duration);
    });
  });
}

function getMusicQueryForNiche(niche) {
  const value = String(niche || "").toLowerCase();
  if (/history|true crime|crime|murder|detective|investigation/.test(value)) {
    return "cinematic dramatic dark";
  }
  if (/space|science|cosmos|physics|nasa|astronomy/.test(value)) {
    return "cinematic epic space";
  }
  if (/technology|tech|software|ai|digital|internet/.test(value)) {
    return "modern corporate upbeat";
  }
  if (/finance|market|stock|business|economy|money/.test(value)) {
    return "corporate professional";
  }
  return "cinematic documentary";
}

function getClipCaptionDuration(clip) {
  const trimStart = Number(clip?.trim_start ?? 0);
  const trimEnd = Number(clip?.trim_end ?? 0);
  const byTrim = trimEnd - trimStart;
  if (Number.isFinite(byTrim) && byTrim > 0) {
    return byTrim;
  }
  return getClipDuration(clip);
}

function truncateAtWordBoundary(text, maxChars) {
  const input = String(text || "").trim();
  if (input.length <= maxChars) {
    return input;
  }
  const slice = input.slice(0, maxChars + 1);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) {
    return slice.slice(0, lastSpace).trim();
  }
  return input.slice(0, maxChars).trim();
}

function splitIntoTwoCaptionLines(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return text;
  }
  const mid = Math.ceil(words.length / 2);
  const line1 = words.slice(0, mid).join(" ").trim();
  const line2 = words.slice(mid).join(" ").trim();
  if (!line1 || !line2) {
    return text;
  }
  return `${line1}\n${line2}`;
}

function formatCaptionText(narration) {
  const normalized = String(narration || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 100) {
    return normalized;
  }
  const truncated = truncateAtWordBoundary(normalized, 100);
  return splitIntoTwoCaptionLines(truncated);
}

function escapeDrawtextText(input) {
  return String(input || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function buildCaptionDrawtextFilters(clips) {
  let cursor = 0;
  return clips
    .map((clip) => {
      const narration = String(clip?.narration || "").trim();
      if (!narration) {
        cursor += getClipCaptionDuration(clip);
        return null;
      }
      const start = cursor;
      const duration = Math.max(0.1, getClipCaptionDuration(clip));
      const end = start + duration;
      cursor = end;
      const text = escapeDrawtextText(formatCaptionText(narration));
      return (
        "drawtext=" +
        `text='${text}':` +
        "font=DejaVuSans-Bold:" +
        "fontcolor=white:" +
        "fontsize=52:" +
        "borderw=4:" +
        "bordercolor=black:" +
        "x=(w-text_w)/2:" +
        "y=h-(text_h*2):" +
        `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
      );
    })
    .filter(Boolean);
}

async function searchPixabayMusicTrack(query, pixabayApiKey) {
  const url = new URL("https://pixabay.com/api/audio/");
  url.searchParams.set("key", pixabayApiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "10");

  console.log("[assembly-server] Searching Pixabay music", { query });
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Pixabay music search failed: HTTP ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  const first = hits.find((hit) => hit?.audio || hit?.url);
  if (!first) {
    return null;
  }

  const audioUrl =
    first.audio ??
    first.url ??
    first.previewURL ??
    first?.audio_url ??
    null;
  if (!audioUrl) {
    return null;
  }
  return { audioUrl, track: first };
}

function mixBackgroundMusic(inputVideoPath, musicPath, outputPath, finalDuration) {
  return new Promise((resolve, reject) => {
    const fadeOutStart = Math.max(0, finalDuration - 4);
    attachFfmpegLogging(
      ffmpeg()
        .input(inputVideoPath)
        .input(musicPath)
        .inputOptions(["-stream_loop", "-1"])
        .complexFilter([
          `[1:a]volume=-18dB,afade=t=in:st=0:d=3,afade=t=out:st=${fadeOutStart}:d=4[a_bg]`,
          "[0:a][a_bg]amix=inputs=2:duration=first:dropout_transition=3[a_mix]",
        ])
        .outputOptions([
          "-map",
          "0:v:0",
          "-map",
          "[a_mix]",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-t",
          String(finalDuration),
          "-shortest",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath),
    )
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

function burnCaptions(inputVideoPath, outputPath, clips) {
  const drawtextFilters = buildCaptionDrawtextFilters(clips);
  if (!drawtextFilters.length) {
    return fs.copyFile(inputVideoPath, outputPath);
  }
  return new Promise((resolve, reject) => {
    attachFfmpegLogging(
      ffmpeg(inputVideoPath)
        .videoFilters(drawtextFilters.join(","))
        .outputOptions([
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "22",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "copy",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath),
    )
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/**
 * Normalise stock video to 1080p, 30 fps CFR, yuv420p, no audio — before trimming/mux with voiceover.
 */
function normalizeStockVideoForMux(srcPath, outputPath) {
  return new Promise((resolve, reject) => {
    attachFfmpegLogging(
      ffmpeg(srcPath)
        .videoFilters(
          "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p",
        )
        .outputOptions([
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "28",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-vsync",
          "cfr",
          "-an",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath),
    )
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

/** Strip any audio from stock footage so mux only uses the voiceover track. */
function stripStockAudio(stockPath, outputPath) {
  return new Promise((resolve, reject) => {
    attachFfmpegLogging(
      ffmpeg(stockPath)
        .outputOptions(["-c:v", "copy", "-an", "-movflags", "+faststart"])
        .output(outputPath),
    )
      .on("end", () => resolve())
      .on("error", (copyErr) => {
        console.warn("[assembly-server] Stream-copy strip audio failed, re-encoding", {
          message: copyErr.message,
        });
        attachFfmpegLogging(
          ffmpeg(stockPath)
            .outputOptions([
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-an",
              "-movflags",
              "+faststart",
            ])
            .output(outputPath),
        )
          .on("end", () => resolve())
          .on("error", (err) => reject(err))
          .run();
      })
      .run();
  });
}

async function downloadToFile(url, destPath, label) {
  console.log("[assembly-server] Downloading", { label, url: url?.slice(0, 120) });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download ${label}: HTTP ${response.status} ${response.statusText}`,
    );
  }

  if (response.body) {
    await pipeline(response.body, createWriteStream(destPath));
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
  }

  const stat = await fs.stat(destPath);
  console.log("[assembly-server] Download complete", { label, bytes: stat.size });
}

function runFfmpegSceneMux(
  stockPath,
  voicePath,
  outputPath,
  targetDuration,
  sourceDuration,
  trimStart,
) {
  return new Promise((resolve, reject) => {
    const availableDuration = Math.max(0.1, sourceDuration - trimStart);
    const needsLoop = targetDuration > availableDuration + 0.05;
    const streamLoop = needsLoop
      ? Math.max(0, Math.ceil(targetDuration / availableDuration) - 1)
      : 0;

    const inputOptions = ["-ss", String(trimStart)];
    let command = ffmpeg();

    if (needsLoop) {
      command = command
        .input(stockPath)
        .inputOptions([...inputOptions, "-stream_loop", String(streamLoop)]);
    } else {
      command = command.input(stockPath).inputOptions(inputOptions);
    }

    attachFfmpegLogging(
      command
        .input(voicePath)
        .videoFilters(
          "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p",
        )
        .outputOptions([
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "libx264",
          "-crf",
          "28",
          "-preset",
          "fast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "30",
          "-vsync",
          "cfr",
          "-c:a",
          "aac",
          "-ar",
          "44100",
          "-ac",
          "2",
          "-t",
          String(targetDuration),
          "-shortest",
          "-movflags",
          "+faststart",
        ])
        .output(outputPath),
    )
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

async function buildSceneSegment(clip, index, workDir) {
  const targetDuration = Math.max(0.1, getClipDuration(clip));
  const trimStart = Math.max(0, Number(clip.trim_start ?? 0));
  const voicePath = path.join(workDir, `scene_${index}_voice.mp3`);
  const outputPath = path.join(workDir, `scene_${index}.mp4`);

  if (!clip.file_url) {
    throw new Error(`Clip ${index} is missing file_url`);
  }
  if (!clip.voice_url) {
    throw new Error(`Clip ${index} is missing voice_url`);
  }

  const stockRawPath = path.join(workDir, `scene_${index}_stock_raw.mp4`);
  const stockNoAudioPath = path.join(workDir, `scene_${index}_stock_noaudio.mp4`);
  const stockNormalizedPath = path.join(workDir, `scene_${index}_stock_normalized.mp4`);

  await downloadToFile(clip.file_url, stockRawPath, `stock-${index}`);
  await stripStockAudio(stockRawPath, stockNoAudioPath);
  await normalizeStockVideoForMux(stockNoAudioPath, stockNormalizedPath);
  await downloadToFile(clip.voice_url, voicePath, `voice-${index}`);

  const sourceDuration = await probeMediaDuration(stockNormalizedPath);

  await runFfmpegSceneMux(
    stockNormalizedPath,
    voicePath,
    outputPath,
    targetDuration,
    sourceDuration,
    trimStart,
  );

  return outputPath;
}

function runFfmpegConcatDemuxer(segmentPaths, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      if (segmentPaths.length === 1) {
        await fs.copyFile(segmentPaths[0], outputPath);
        resolve();
        return;
      }

      const listPath = path.join(path.dirname(outputPath), "concat-list.txt");
      const listContent = segmentPaths
        .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
        .join("\n");

      await fs.writeFile(listPath, listContent, "utf8");

      const tryConcat = (reencode) =>
        new Promise((res, rej) => {
          const command = ffmpeg()
            .input(listPath)
            .inputOptions(["-f", "concat", "-safe", "0"]);

          if (reencode) {
            command.outputOptions([
              "-c:v",
              "libx264",
              "-preset",
              "fast",
              "-pix_fmt",
              "yuv420p",
              "-r",
              "30",
              "-c:a",
              "aac",
              "-ar",
              "44100",
              "-ac",
              "2",
              "-movflags",
              "+faststart",
            ]);
          } else {
            command.outputOptions(["-c", "copy"]);
          }

          attachFfmpegLogging(command.output(outputPath))
            .on("end", () => res())
            .on("error", (err) => rej(err))
            .run();
        });

      try {
        await tryConcat(false);
        resolve();
      } catch {
        await tryConcat(true);
        resolve();
      }
    } catch (error) {
      reject(error);
    }
  });
}

function configureCloudinary(cloudinaryConfig) {
  const { cloud_name, api_key, api_secret } = cloudinaryConfig ?? {};

  if (!cloud_name || !api_key || !api_secret) {
    throw new Error(
      "cloudinaryConfig must include cloud_name, api_key, and api_secret",
    );
  }

  cloudinary.config({
    cloud_name,
    api_key,
    api_secret,
    secure: true,
  });
}

async function uploadFinalVideo(filePath, videoId) {
  const publicId = `autopilot/${videoId}/final`;

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: "video",
    public_id: publicId,
    overwrite: true,
    timeout: 300000,
  });

  return result;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/assemble", async (req, res) => {
  const { clips, videoId, niche, cloudinaryConfig } = req.body ?? {};
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "autopilot-assembly-"));

  console.log("[assembly-server] POST /assemble", {
    videoId,
    clipCount: Array.isArray(clips) ? clips.length : 0,
    workDir,
    ffmpegPath: ffmpegInstaller.path,
    ffprobePath: ffprobeInstaller.path,
  });

  try {
    if (!videoId) {
      res.status(400).json({ error: "videoId is required" });
      return;
    }

    if (!Array.isArray(clips) || clips.length === 0) {
      res.status(400).json({ error: "clips must be a non-empty array" });
      return;
    }

    configureCloudinary(cloudinaryConfig);

    const segmentPaths = [];
    for (let i = 0; i < clips.length; i++) {
      console.log("[assembly-server] Building scene", { index: i, videoId });
      segmentPaths.push(await buildSceneSegment(clips[i], i, workDir));
    }

    const finalPath = path.join(workDir, "final.mp4");
    console.log("[assembly-server] Concatenating segments", {
      count: segmentPaths.length,
    });
    await runFfmpegConcatDemuxer(segmentPaths, finalPath);

    const finalDuration = await probeMediaDuration(finalPath);

    let processedPath = finalPath;
    const pixabayApiKey = cloudinaryConfig?.pixabayApiKey || process.env.PIXABAY_API_KEY;
    if (pixabayApiKey) {
      try {
        const musicQuery = getMusicQueryForNiche(niche);
        const music = await searchPixabayMusicTrack(musicQuery, pixabayApiKey);
        if (music?.audioUrl) {
          const musicPath = path.join(workDir, "bg-music.mp3");
          const withMusicPath = path.join(workDir, "final-with-music.mp4");
          await downloadToFile(music.audioUrl, musicPath, "bg-music");
          await mixBackgroundMusic(finalPath, musicPath, withMusicPath, finalDuration);
          processedPath = withMusicPath;
          console.log("[assembly-server] Background music mixed", {
            videoId,
            musicQuery,
            audioUrl: music.audioUrl?.slice?.(0, 120),
          });
        } else {
          console.warn("[assembly-server] No Pixabay music results, continuing without music", {
            videoId,
            niche,
            musicQuery,
          });
        }
      } catch (musicError) {
        console.warn("[assembly-server] Music mix failed, continuing without music", {
          videoId,
          niche,
          message: musicError instanceof Error ? musicError.message : String(musicError),
        });
      }
    } else {
      console.warn("[assembly-server] No pixabayApiKey provided, skipping background music");
    }

    const withCaptionsPath = path.join(workDir, "final-with-captions.mp4");
    try {
      await burnCaptions(processedPath, withCaptionsPath, clips);
      processedPath = withCaptionsPath;
    } catch (captionError) {
      console.warn("[assembly-server] Caption burn failed, continuing without captions", {
        videoId,
        message:
          captionError instanceof Error ? captionError.message : String(captionError),
      });
    }

    console.log("[assembly-server] Uploading final video", { videoId, finalDuration });

    const upload = await uploadFinalVideo(processedPath, videoId);

    res.json({
      file_url: upload.secure_url,
      duration: upload.duration ?? finalDuration,
      public_id: upload.public_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[assembly-server] Assembly failed", { videoId, message, error });
    res.status(500).json({ error: message });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log("[assembly-server] Listening", {
    port: PORT,
    ffmpegPath: ffmpegInstaller.path,
    ffprobePath: ffprobeInstaller.path,
  });
});
