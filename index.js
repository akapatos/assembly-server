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

    command
      .input(voicePath)
      .duration(targetDuration)
      .videoFilters(
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
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
        "-c:a",
        "aac",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-shortest",
        "-movflags",
        "+faststart",
      ])
      .output(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run();
  });
}

async function buildSceneSegment(clip, index, workDir) {
  const targetDuration = Math.max(0.1, getClipDuration(clip));
  const trimStart = Math.max(0, Number(clip.trim_start ?? 0));
  const stockPath = path.join(workDir, `scene_${index}_stock.mp4`);
  const voicePath = path.join(workDir, `scene_${index}_voice.mp3`);
  const outputPath = path.join(workDir, `scene_${index}.mp4`);

  if (!clip.file_url) {
    throw new Error(`Clip ${index} is missing file_url`);
  }
  if (!clip.voice_url) {
    throw new Error(`Clip ${index} is missing voice_url`);
  }

  await downloadToFile(clip.file_url, stockPath, `stock-${index}`);
  await downloadToFile(clip.voice_url, voicePath, `voice-${index}`);

  const sourceDuration = await probeMediaDuration(stockPath);

  await runFfmpegSceneMux(
    stockPath,
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

          command
            .output(outputPath)
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
  const { clips, videoId, cloudinaryConfig } = req.body ?? {};
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
    console.log("[assembly-server] Uploading final video", { videoId, finalDuration });

    const upload = await uploadFinalVideo(finalPath, videoId);

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
