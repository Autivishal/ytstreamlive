require("dotenv").config();

const express = require("express");
const path = require("path");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Helper function to get clean, trimmed expected API Token
function getExpectedToken() {
    return (process.env.API_TOKEN || "").trim();
}

let ffmpegProcess = null;
let streamStartTime = null;

app.post("/start-stream", (req, res) => {
    const { token, videoUrl, streamKey } = req.body;
    const expectedToken = getExpectedToken();
    const receivedToken = (token || "").trim();

    console.log(`[${new Date().toISOString()}] POST /start-stream received.`);

    if (!expectedToken) {
        console.error("ERROR: API_TOKEN is not configured in server environment (.env).");
        return res.status(500).json({
            success: false,
            message: "Server configuration error: API_TOKEN is not set in environment."
        });
    }

    if (receivedToken !== expectedToken) {
        console.warn(`[AUTH FAILED] Received token length: ${receivedToken.length}, Expected token length: ${expectedToken.length}`);
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (ffmpegProcess) {
        console.warn("[START STREAM] Request rejected: Stream already running.");
        return res.status(400).json({
            success: false,
            message: "Stream already running"
        });
    }

    console.log(`[START STREAM] Starting FFmpeg process for video: ${videoUrl}`);
    streamStartTime = Date.now();

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
        console.log(`[FFmpeg STDERR] ${data.toString().trim()}`);
    });

    ffmpegProcess.on("error", err => {
        console.error("[FFmpeg ERROR]", err);
    });

    ffmpegProcess.on("close", code => {
        console.log(`[FFmpeg EXIT] Process exited with code ${code}`);
        ffmpegProcess = null;
        streamStartTime = null;
    });

    setTimeout(() => {
        if (ffmpegProcess) {
            console.log("[FFmpeg TIMEOUT] 24-hour stream limit reached. Stopping stream.");
            ffmpegProcess.kill("SIGTERM");
            ffmpegProcess = null;
            streamStartTime = null;
        }
    }, 24 * 60 * 60 * 1000);

    res.json({
        success: true,
        message: "Stream started"
    });
});

app.post("/stop-stream", (req, res) => {
    const { token } = req.body;
    const expectedToken = getExpectedToken();
    const receivedToken = (token || "").trim();

    console.log(`[${new Date().toISOString()}] POST /stop-stream received.`);

    if (receivedToken !== expectedToken) {
        console.warn(`[AUTH FAILED] Stop stream rejected: Invalid token.`);
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (ffmpegProcess) {
        console.log("[STOP STREAM] Terminating FFmpeg process via SIGTERM.");
        ffmpegProcess.kill("SIGTERM");
        ffmpegProcess = null;
        streamStartTime = null;
    } else {
        console.log("[STOP STREAM] No active stream running.");
    }

    res.json({
        success: true,
        message: "Stream stopped"
    });
});

app.get("/health", (req, res) => {
    const uptimeSeconds = streamStartTime ? Math.floor((Date.now() - streamStartTime) / 1000) : 0;
    res.json({
        running: !!ffmpegProcess,
        uptime: uptimeSeconds
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
    const port = process.env.PORT || 3000;
    const token = getExpectedToken();
    console.log(`Server started on port ${port}`);
    if (token) {
        console.log(`[CONFIG] API_TOKEN loaded (Length: ${token.length} chars)`);
    } else {
        console.warn(`[CONFIG WARNING] API_TOKEN is missing or empty in environment!`);
    }
});