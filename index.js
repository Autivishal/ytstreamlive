require("dotenv").config({ override: true });

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const multer = require("multer");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { Upload } = require("@aws-sdk/lib-storage");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Helper function to resolve S3 URLs into 24-hour Presigned GET URLs for FFmpeg access
async function resolveStreamableUrl(videoUrl) {
    if (!videoUrl) return videoUrl;

    const bucketName = process.env.AWS_BUCKET_NAME;
    const s3Client = getS3Client();
    if (!s3Client || !bucketName) return videoUrl;

    let s3Key = null;
    const trimmedUrl = String(videoUrl).trim();

    if (trimmedUrl.includes("s3.amazonaws.com") || trimmedUrl.includes(".s3.")) {
        if (!trimmedUrl.includes("X-Amz-Signature")) {
            try {
                const parsed = new URL(trimmedUrl);
                let keyPath = decodeURIComponent(parsed.pathname);
                if (keyPath.startsWith(`/${bucketName}/`)) {
                    keyPath = keyPath.substring(bucketName.length + 2);
                } else if (keyPath.startsWith("/")) {
                    keyPath = keyPath.substring(1);
                }
                s3Key = keyPath;
            } catch (e) {
                console.warn("[S3 URL PARSE WARN]", e.message);
            }
        } else {
            return trimmedUrl; // Already presigned
        }
    }

    if (s3Key) {
        try {
            console.log(`[AWS S3 PRESIGNED] Generating 24-hour signed URL for FFmpeg to access private key: ${s3Key}`);
            const signedUrl = await getSignedUrl(s3Client, new GetObjectCommand({
                Bucket: bucketName,
                Key: s3Key
            }), { expiresIn: 86400 });
            return signedUrl;
        } catch (err) {
            console.error("[AWS S3 PRESIGNED ERROR]", err.message);
        }
    }

    return videoUrl;
}

// Multer disk storage configuration supporting up to 5 GB files without OOM issues
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1E9);
        const sanitized = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        cb(null, `${uniqueSuffix}-${sanitized}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: Infinity } // Avoid 32-bit integer overflow truncation in busboy/multer
});

// Helper to construct AWS S3 Client
function getS3Client() {
    const region = process.env.AWS_REGION;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    if (!region || !accessKeyId || !secretAccessKey) return null;

    return new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey }
    });
}

// Helper function to get clean, trimmed expected API Token
function getExpectedToken() {
    return (process.env.API_TOKEN || "").trim();
}

let ffmpegProcess = null;
let streamStartTime = null;

// Endpoint: Upload Video File directly to AWS S3 (Supports up to 5 GB via Multipart Streaming)
app.post("/upload-s3", (req, res, next) => {
    upload.single("videoFile")(req, res, (err) => {
        if (err) {
            console.error("[MULTER ERROR]", err);
            if (err instanceof multer.MulterError) {
                return res.status(400).json({
                    success: false,
                    message: `File upload error: ${err.message}`
                });
            }
            return res.status(500).json({
                success: false,
                message: `Upload processing failed: ${err.message}`
            });
        }
        next();
    });
}, async (req, res) => {
    const token = req.body.token;
    const expectedToken = getExpectedToken();
    const receivedToken = (token || "").trim();

    console.log(`[${new Date().toISOString()}] POST /upload-s3 received.`);

    if (!expectedToken) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).json({
            success: false,
            message: "Server configuration error: API_TOKEN is not set in environment."
        });
    }

    if (receivedToken !== expectedToken) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (!req.file) {
        return res.status(400).json({
            success: false,
            message: "No video file uploaded."
        });
    }

    const FIVE_GB = 5 * 1024 * 1024 * 1024;
    if (req.file.size > FIVE_GB) {
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({
            success: false,
            message: "File upload error: File size exceeds the maximum allowed limit of 5 GB."
        });
    }

    const bucketName = process.env.AWS_BUCKET_NAME;
    const region = process.env.AWS_REGION;
    const s3 = getS3Client();

    if (!s3 || !bucketName) {
        if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        console.error("[AWS S3] Missing environment variables: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_BUCKET_NAME");
        return res.status(500).json({
            success: false,
            message: "AWS S3 credentials not configured in server environment (.env). Please set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and AWS_BUCKET_NAME."
        });
    }

    const tempFilePath = req.file.path;

    // Set streaming headers for real-time progress updates to browser
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const sendEvent = (obj) => {
        if (!res.writableEnded) {
            res.write(JSON.stringify(obj) + "\n");
        }
    };

    try {
        const sanitizedName = req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const fileKey = `videos/${Date.now()}_${sanitizedName}`;
        const fileSizeGB = (req.file.size / (1024 * 1024 * 1024)).toFixed(2);
        const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(2);
        const displaySize = req.file.size >= 1024 * 1024 * 1024 ? `${fileSizeGB} GB` : `${fileSizeMB} MB`;

        console.log(`[AWS S3] Streaming upload for ${req.file.originalname} (${displaySize}) to bucket: ${bucketName}...`);
        sendEvent({ type: "start", message: `Starting streaming upload to AWS S3 (${displaySize})...` });

        const createParallelUploader = (s3ClientInstance) => {
            const uploader = new Upload({
                client: s3ClientInstance,
                params: {
                    Bucket: bucketName,
                    Key: fileKey,
                    Body: fs.createReadStream(tempFilePath),
                    ContentType: req.file.mimetype || "video/mp4"
                },
                partSize: 10 * 1024 * 1024, // 10MB chunk parts
                queueSize: 4,
                leavePartsOnError: false
            });

            let lastPercent = -1;
            uploader.on("httpUploadProgress", (progress) => {
                if (!progress.total) return;
                const percent = Math.floor((progress.loaded / progress.total) * 100);
                if (percent !== lastPercent) {
                    lastPercent = percent;
                    sendEvent({
                        type: "progress",
                        percent,
                        loaded: progress.loaded,
                        total: progress.total
                    });
                }
            });

            return uploader;
        };

        try {
            const parallelUpload = createParallelUploader(s3);
            await parallelUpload.done();
        } catch (initialErr) {
            if (initialErr.message && initialErr.message.includes("addressed using the specified endpoint")) {
                console.warn("[AWS S3] Endpoint redirect detected. Retrying with global S3 endpoint fallback...");
                const fallbackClient = new S3Client({
                    region: "us-east-1",
                    endpoint: "https://s3.amazonaws.com",
                    credentials: {
                        accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").trim(),
                        secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").trim()
                    }
                });
                const fallbackUpload = createParallelUploader(fallbackClient);
                await fallbackUpload.done();
            } else {
                throw initialErr;
            }
        }

        const s3Url = (region === "us-east-1")
            ? `https://${bucketName}.s3.amazonaws.com/${fileKey}`
            : `https://${bucketName}.s3.${region}.amazonaws.com/${fileKey}`;

        console.log(`[AWS S3 SUCCESS] File uploaded (${displaySize}) to: ${s3Url}`);

        sendEvent({
            type: "complete",
            success: true,
            message: `Video (${displaySize}) uploaded to AWS S3 successfully!`,
            url: s3Url,
            fileKey
        });
        res.end();
    } catch (err) {
        console.error("[AWS S3 ERROR]", err);
        sendEvent({
            type: "error",
            success: false,
            message: `S3 Upload Error: ${err.message}`
        });
        res.end();
    } finally {
        // Clean up temporary disk file
        if (fs.existsSync(tempFilePath)) {
            fs.unlink(tempFilePath, (unlinkErr) => {
                if (unlinkErr) console.error("[TEMP FILE CLEANUP ERROR]", unlinkErr);
            });
        }
    }
});

app.post("/start-stream", async (req, res) => {
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

    if (!streamKey || streamKey.trim().length < 5) {
        console.warn("[START STREAM] Request rejected: YouTube Stream Key is missing or invalid.");
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube Stream Key. Please enter a valid stream key from YouTube Studio."
        });
    }

    const resolvedUrl = await resolveStreamableUrl(videoUrl);
    const maskedKey = streamKey.length > 8 ? streamKey.substring(0, 4) + "..." + streamKey.substring(streamKey.length - 4) : "****";
    console.log(`[START STREAM] Starting FFmpeg live stream loop...`);
    console.log(`[START STREAM] Input Source: ${resolvedUrl.substring(0, 100)}...`);
    console.log(`[START STREAM] Target RTMP: rtmp://a.rtmp.youtube.com/live2/${maskedKey}`);
    
    streamStartTime = Date.now();

    ffmpegProcess = spawn(ffmpegPath, [
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-re",
        "-stream_loop", "-1",
        "-i", resolvedUrl,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-maxrate", "3000k",
        "-bufsize", "6000k",
        "-pix_fmt", "yuv420p",
        "-g", "60",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-f", "flv",
        `rtmp://a.rtmp.youtube.com/live2/${streamKey.trim()}`
    ]);

    ffmpegProcess.stderr.on("data", data => {
        const line = data.toString().trim();
        if (line) {
            console.log(`[FFmpeg STDERR] ${line}`);
        }
    });

    ffmpegProcess.on("error", err => {
        console.error("[FFmpeg PROCESS ERROR]", err);
    });

    ffmpegProcess.on("close", (code, signal) => {
        console.log(`[FFmpeg EXIT] Process exited with code ${code}, signal: ${signal}`);
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

// Global Express JSON Error Handler (catches any unhandled errors and prevents HTML output)
app.use((err, req, res, next) => {
    console.error("[GLOBAL SERVER ERROR]", err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error"
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