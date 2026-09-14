require("dotenv").config();

const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

const API_TOKEN = process.env.API_TOKEN;

let ffmpegProcess = null;

app.post("/start-stream", (req, res) => {
    const { token, videoUrl, streamKey } = req.body;

    if (token !== API_TOKEN) {
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (ffmpegProcess) {
        return res.status(400).json({
            success: false,
            message: "Stream already running"
        });
    }

    ffmpegProcess = spawn(ffmpegPath, [
        "-re",
        "-stream_loop", "-1",
        "-i", videoUrl,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        "-f", "flv",
        `rtmp://a.rtmp.youtube.com/live2/${streamKey}`
    ]);

    ffmpegProcess.stderr.on("data", data => {
        console.log(data.toString());
    });

    ffmpegProcess.on("error", err => {
        console.error("FFmpeg error:", err);
    });

    ffmpegProcess.on("close", code => {
        console.log(`FFmpeg exited: ${code}`);
        ffmpegProcess = null;
    });

    setTimeout(() => {
        if (ffmpegProcess) {
            ffmpegProcess.kill("SIGTERM");
            ffmpegProcess = null;
        }
    }, 24 * 60 * 60 * 1000);

    res.json({
        success: true,
        message: "Stream started"
    });
});

app.post("/stop-stream", (req, res) => {
    const { token } = req.body;

    if (token !== API_TOKEN) {
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (ffmpegProcess) {
        ffmpegProcess.kill("SIGTERM");
        ffmpegProcess = null;
    }

    res.json({
        success: true,
        message: "Stream stopped"
    });
});

app.get("/health", (req, res) => {
    res.json({
        running: !!ffmpegProcess
    });
});

app.get("/ffmpeg-check", (req, res) => {
    const ffmpeg = spawn(ffmpegPath, ["-version"]);

    let output = "";

    ffmpeg.stdout.on("data", data => {
        output += data.toString();
    });

    ffmpeg.stderr.on("data", data => {
        output += data.toString();
    });

    ffmpeg.on("error", err => {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    });

    ffmpeg.on("close", code => {
        res.json({
            success: code === 0,
            ffmpegPath,
            output: output.split("\n")[0]
        });
    });
});

app.listen(process.env.PORT || 3000, () => {
    console.log(`Server started on port ${process.env.PORT || 3000}`);
});