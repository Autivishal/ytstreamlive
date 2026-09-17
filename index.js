require("dotenv").config({ override: true });

const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const dns = require("dns");
const crypto = require("crypto");
const ffmpegPath = require("ffmpeg-static");
const { spawn, spawnSync } = require("child_process");
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
            // Clean query parameters that cause FFmpeg Linux GnuTLS header parsing crashes
            const cleanUrl = signedUrl.replace(/&x-amz-checksum-mode=[^&]*/g, '').replace(/&x-id=[^&]*/g, '');
            return cleanUrl;
        } catch (err) {
            console.error("[AWS S3 PRESIGNED ERROR]", err.message);
        }
    }

    return videoUrl;
}

// Helper to download or stream S3 / HTTP video to local disk cache for 100% reliable FFmpeg streaming
async function prepareLocalVideoFile(videoUrl) {
    if (!videoUrl) return videoUrl;

    const trimmedUrl = String(videoUrl).trim();
    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
        return trimmedUrl; // Already a local file path
    }

    const urlHash = crypto.createHash("md5").update(trimmedUrl.split("?")[0]).digest("hex").substring(0, 12);
    const localCachePath = path.join(os.tmpdir(), `cache_video_${urlHash}.mp4`);

    if (fs.existsSync(localCachePath) && fs.statSync(localCachePath).size > 0) {
        const sizeMB = (fs.statSync(localCachePath).size / (1024 * 1024)).toFixed(2);
        console.log(`[VIDEO STREAM CACHE] Reusing existing cached video file (${sizeMB} MB): ${localCachePath}`);
        return localCachePath;
    }

    console.log(`[VIDEO STREAM CACHE] Preparing local stream input file: ${localCachePath}...`);

    const bucketName = process.env.AWS_BUCKET_NAME;
    const s3Client = getS3Client();

    let s3Key = null;
    if (s3Client && bucketName && (trimmedUrl.includes("s3.amazonaws.com") || trimmedUrl.includes(".s3."))) {
        try {
            const parsed = new URL(trimmedUrl);
            let keyPath = decodeURIComponent(parsed.pathname);
            if (keyPath.startsWith(`/${bucketName}/`)) {
                keyPath = keyPath.substring(bucketName.length + 2);
            } else if (keyPath.startsWith("/")) {
                keyPath = keyPath.substring(1);
            }
            s3Key = keyPath;
        } catch (e) {}
    }

    if (s3Key && s3Client && bucketName) {
        try {
            console.log(`[S3 CACHE DOWNLOAD] Fetching object '${s3Key}' directly via AWS S3 SDK to local disk...`);
            const command = new GetObjectCommand({ Bucket: bucketName, Key: s3Key });
            const s3Response = await s3Client.send(command);
            const writeStream = fs.createWriteStream(localCachePath);

            await new Promise((resolve, reject) => {
                s3Response.Body.pipe(writeStream);
                s3Response.Body.on("error", reject);
                writeStream.on("finish", resolve);
                writeStream.on("error", reject);
            });

            const sizeMB = (fs.statSync(localCachePath).size / (1024 * 1024)).toFixed(2);
            console.log(`[S3 CACHE DOWNLOAD SUCCESS] Saved S3 video to local disk (${sizeMB} MB).`);
            return localCachePath;
        } catch (s3DownloadErr) {
            console.warn(`[S3 CACHE DOWNLOAD WARN] Direct S3 download failed (${s3DownloadErr.message}). Falling back to HTTP URL stream...`);
        }
    }

    // Generic HTTP/HTTPS download fallback
    try {
        const presignedUrl = await resolveStreamableUrl(trimmedUrl);
        const httpModule = presignedUrl.startsWith("https") ? require("https") : require("http");

        await new Promise((resolve, reject) => {
            const fileStream = fs.createWriteStream(localCachePath);
            const request = httpModule.get(presignedUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    const redirModule = response.headers.location.startsWith("https") ? require("https") : require("http");
                    redirModule.get(response.headers.location, (redirRes) => {
                        redirRes.pipe(fileStream);
                        fileStream.on("finish", resolve);
                        fileStream.on("error", reject);
                    }).on("error", reject);
                } else if (response.statusCode === 200) {
                    response.pipe(fileStream);
                    fileStream.on("finish", resolve);
                    fileStream.on("error", reject);
                } else {
                    reject(new Error(`HTTP Download failed with status ${response.statusCode}`));
                }
            });
            request.on("error", reject);
        });

        const sizeMB = (fs.statSync(localCachePath).size / (1024 * 1024)).toFixed(2);
        console.log(`[HTTP CACHE DOWNLOAD SUCCESS] Saved video to local disk (${sizeMB} MB).`);
        return localCachePath;
    } catch (httpErr) {
        console.error(`[VIDEO CACHE ERROR] Download failed: ${httpErr.message}. Passing original URL to FFmpeg...`);
        return await resolveStreamableUrl(trimmedUrl);
    }
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

// Determine the most reliable FFmpeg binary executable path
function getExecutableFFmpegPath() {
    try {
        const test = spawnSync("ffmpeg", ["-version"]);
        if (test.status === 0) {
            console.log("[FFmpeg BINARY] Using system-installed FFmpeg binary.");
            return "ffmpeg";
        }
    } catch (e) {}
    console.log("[FFmpeg BINARY] Using static FFmpeg package binary.");
    return ffmpegPath;
}

// Resolve RTMP domain names into IPv4 addresses using Node.js DNS to prevent static glibc SIGSEGV crashes in FFmpeg static binaries
async function resolveRtmpTargetAddress(streamKey) {
    const rawHost = "a.rtmp.youtube.com";
    let targetIp = rawHost;
    try {
        const resolved = await dns.promises.lookup(rawHost, { family: 4 });
        if (resolved && resolved.address) {
            targetIp = resolved.address;
            console.log(`[DNS RESOLVE SUCCESS] Resolved YouTube RTMP host '${rawHost}' to IPv4 target: '${targetIp}'`);
        }
    } catch (dnsErr) {
        console.warn(`[DNS RESOLVE WARN] Could not resolve ${rawHost} to IPv4 (${dnsErr.message}). Falling back to domain name.`);
    }
    return `rtmp://${targetIp}/live2/${streamKey.trim()}`;
}

const activeStreams = new Map(); // Key: streamId
const MAX_CONCURRENT_STREAMS = 10; // Safety cap for Render Free Tier (512 MB RAM)
const MAX_STREAM_DURATION_MS = 12 * 60 * 60 * 1000; // 12-hour limit per stream

function spawnStreamLoop(streamId) {
    const stream = activeStreams.get(streamId);
    if (!stream || !stream.isStreamActive) return;

    const activeFFmpegPath = getExecutableFFmpegPath();

    console.log(`[FFmpeg ENGINE][${streamId}] Spawning stream loop iteration...`);
    console.log(`[FFmpeg ENGINE][${streamId}] Binary path: ${activeFFmpegPath}`);
    console.log(`[FFmpeg ENGINE][${streamId}] Input Source: ${stream.resolvedUrl.substring(0, 100)}...`);
    console.log(`[FFmpeg ENGINE][${streamId}] Target RTMP: rtmp://a.rtmp.youtube.com/live2/${stream.maskedKey}`);

    const processInstance = spawn(activeFFmpegPath, [
        "-re",
        "-stream_loop", "-1",
        "-i", stream.resolvedUrl,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-g", "60",
        "-keyint_min", "60",
        "-sc_threshold", "0",
        "-c:a", "copy",
        "-f", "flv",
        stream.rtmpTargetUrl || `rtmp://a.rtmp.youtube.com/live2/${stream.streamKey.trim()}`
    ]);

    stream.ffmpegProcess = processInstance;

    processInstance.stderr.on("data", data => {
        const line = data.toString().trim();
        if (line) {
            console.log(`[FFmpeg STDERR][${streamId}] ${line}`);
        }
    });

    processInstance.on("error", err => {
        console.error(`[FFmpeg PROCESS ERROR][${streamId}]`, err);
    });

    processInstance.on("close", (code, signal) => {
        console.log(`[FFmpeg EXIT][${streamId}] Process exited with code ${code}, signal: ${signal}`);
        const currentStream = activeStreams.get(streamId);
        if (!currentStream) return;

        currentStream.ffmpegProcess = null;

        // Auto-restart loop if streaming is active for this stream and not stopped explicitly by user
        if (currentStream.isStreamActive) {
            console.log(`[FFmpeg ENGINE][${streamId}] FFmpeg exited. Auto-restarting stream loop in 2s...`);
            setTimeout(() => {
                if (activeStreams.has(streamId) && activeStreams.get(streamId).isStreamActive) {
                    spawnStreamLoop(streamId);
                }
            }, 2000);
        } else {
            stopAndRemoveStream(streamId);
            console.log(`[FFmpeg ENGINE][${streamId}] Stream stopped cleanly.`);
        }
    });
}

function stopAndRemoveStream(streamId) {
    const stream = activeStreams.get(streamId);
    if (!stream) return false;

    stream.isStreamActive = false;

    if (stream.durationTimeout) {
        clearTimeout(stream.durationTimeout);
        stream.durationTimeout = null;
    }

    if (stream.ffmpegProcess) {
        try {
            stream.ffmpegProcess.kill("SIGTERM");
        } catch (e) {}
        stream.ffmpegProcess = null;
    }

    activeStreams.delete(streamId);
    console.log(`[STREAM REMOVED] Stream ${streamId} successfully terminated and removed.`);
    return true;
}

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

    if (!streamKey || streamKey.trim().length < 5) {
        console.warn("[START STREAM] Request rejected: YouTube Stream Key is missing or invalid.");
        return res.status(400).json({
            success: false,
            message: "Invalid YouTube Stream Key. Please enter a valid stream key from YouTube Studio."
        });
    }

    const cleanKey = streamKey.trim();

    // Check if a stream with identical streamKey is already running
    for (const [sId, sObj] of activeStreams.entries()) {
        if (sObj.streamKey === cleanKey) {
            console.warn(`[START STREAM] Rejected: Stream key ${sObj.maskedKey} is already streaming.`);
            return res.status(400).json({
                success: false,
                message: `A stream is already active for this YouTube Stream Key (${sObj.maskedKey}).`
            });
        }
    }

    // Safety limit check for Render Free Tier
    if (activeStreams.size >= MAX_CONCURRENT_STREAMS) {
        console.warn(`[START STREAM] Rejected: Max capacity of ${MAX_CONCURRENT_STREAMS} streams reached.`);
        return res.status(400).json({
            success: false,
            message: `Maximum stream capacity reached (${MAX_CONCURRENT_STREAMS} active streams). Stop an existing stream before launching a new one.`
        });
    }

    const streamId = `stream_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const resolvedUrl = await prepareLocalVideoFile(videoUrl);
    const rtmpTargetUrl = await resolveRtmpTargetAddress(cleanKey);
    const maskedKey = cleanKey.length > 8 ? cleanKey.substring(0, 4) + "..." + cleanKey.substring(cleanKey.length - 4) : "****";

    const durationTimeout = setTimeout(() => {
        console.log(`[FFmpeg TIMEOUT][${streamId}] 12-hour limit reached. Auto-stopping stream.`);
        stopAndRemoveStream(streamId);
    }, MAX_STREAM_DURATION_MS);

    const streamEntry = {
        streamId,
        streamKey: cleanKey,
        maskedKey,
        videoUrl,
        resolvedUrl,
        rtmpTargetUrl,
        ffmpegProcess: null,
        startTime: Date.now(),
        isStreamActive: true,
        durationTimeout
    };

    activeStreams.set(streamId, streamEntry);
    spawnStreamLoop(streamId);

    res.json({
        success: true,
        message: "Live stream started successfully",
        streamId,
        maskedKey
    });
});

app.post("/stop-stream", (req, res) => {
    const { token, streamId } = req.body;
    const expectedToken = getExpectedToken();
    const receivedToken = (token || "").trim();

    console.log(`[${new Date().toISOString()}] POST /stop-stream received (Target streamId: ${streamId || "ALL"}).`);

    if (receivedToken !== expectedToken) {
        console.warn(`[AUTH FAILED] Stop stream rejected: Invalid token.`);
        return res.status(401).json({
            success: false,
            message: "Invalid token"
        });
    }

    if (streamId) {
        const stopped = stopAndRemoveStream(streamId);
        if (!stopped) {
            return res.status(404).json({
                success: false,
                message: `Stream with ID '${streamId}' was not found or is not active.`
            });
        }
        return res.json({
            success: true,
            message: `Stream '${streamId}' stopped successfully.`
        });
    }

    // Stop all active streams if no streamId specified
    let stoppedCount = 0;
    for (const sId of Array.from(activeStreams.keys())) {
        if (stopAndRemoveStream(sId)) stoppedCount++;
    }

    res.json({
        success: true,
        message: `Stopped ${stoppedCount} active stream(s).`
    });
});

app.get("/health", (req, res) => {
    const streamsList = [];
    const now = Date.now();

    for (const [sId, sObj] of activeStreams.entries()) {
        const uptimeSeconds = Math.floor((now - sObj.startTime) / 1000);
        streamsList.push({
            streamId: sId,
            maskedKey: sObj.maskedKey,
            videoUrl: sObj.videoUrl,
            uptimeSeconds,
            running: sObj.isStreamActive
        });
    }

    res.json({
        running: activeStreams.size > 0,
        runningCount: activeStreams.size,
        maxLimit: MAX_CONCURRENT_STREAMS,
        streams: streamsList
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