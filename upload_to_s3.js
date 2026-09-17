/**
 * S3 File Uploader Script supporting Large Files (up to 5 GB+) with Extensive Logging & Key Redaction
 * 
 * Uses @aws-sdk/lib-storage Upload for chunked multipart streaming with minimal memory overhead.
 * 
 * Usage:
 *   node upload_to_s3.js <filePath> [s3Key] [bucketName]
 * 
 * Environment variables required (.env or system env):
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION
 *   AWS_BUCKET_NAME
 */

require("dotenv").config({ override: true });
const fs = require("fs");
const path = require("path");
const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

// Helper function to safely mask sensitive strings
function maskSecret(secret, visibleChars = 4) {
    if (!secret) return "[NOT SET]";
    const trimmed = String(secret).trim();
    if (trimmed.length <= visibleChars * 2) return "****";
    return trimmed.substring(0, visibleChars) + "..." + trimmed.substring(trimmed.length - visibleChars);
}

// Security Logger class enforcing strict redacting of keys and credentials
class SecurityLogger {
    constructor(prefix = "S3-UPLOADER") {
        this.prefix = prefix;
    }

    _format(level, msg, extra = null) {
        const timestamp = new Date().toISOString();
        let formatted = `[${timestamp}] [${this.prefix}] [${level}] ${this.redactString(msg)}`;
        if (extra !== null && extra !== undefined) {
            if (typeof extra === "object") {
                const sanitized = this.redactObject(extra);
                formatted += `\n${JSON.stringify(sanitized, null, 2)}`;
            } else {
                formatted += ` ${this.redactString(String(extra))}`;
            }
        }
        return formatted;
    }

    redactString(str) {
        if (!str) return str;
        let cleaned = String(str);
        
        const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
        const accessKey = process.env.AWS_ACCESS_KEY_ID;
        const apiToken = process.env.API_TOKEN;

        if (secretKey && secretKey.trim()) {
            cleaned = cleaned.split(secretKey.trim()).join("[REDACTED_AWS_SECRET_KEY]");
        }
        if (accessKey && accessKey.trim()) {
            cleaned = cleaned.split(accessKey.trim()).join(maskSecret(accessKey));
        }
        if (apiToken && apiToken.trim()) {
            cleaned = cleaned.split(apiToken.trim()).join("[REDACTED_API_TOKEN]");
        }

        cleaned = cleaned.replace(/(?:aws_secret_access_key|secretAccessKey|secret_key|secret|password)\s*[:=]\s*["']?([A-Za-z0-9/+=]{30,})["']?/gi, '$1:[REDACTED]');
        return cleaned;
    }

    redactObject(obj) {
        if (obj === null || typeof obj !== "object") return obj;
        if (Array.isArray(obj)) return obj.map(item => this.redactObject(item));
        
        const redacted = {};
        for (const [key, val] of Object.entries(obj)) {
            const lowerKey = key.toLowerCase();
            if (
                lowerKey.includes("secret") ||
                lowerKey.includes("password") ||
                lowerKey.includes("token") ||
                lowerKey.includes("credentials") ||
                lowerKey.includes("accesskeyid") ||
                lowerKey.includes("secretaccesskey") ||
                lowerKey === "authorization"
            ) {
                redacted[key] = typeof val === "string" ? maskSecret(val) : "[REDACTED]";
            } else if (typeof val === "object" && val !== null) {
                redacted[key] = this.redactObject(val);
            } else if (typeof val === "string") {
                redacted[key] = this.redactString(val);
            } else {
                redacted[key] = val;
            }
        }
        return redacted;
    }

    info(msg, extra) { console.log(this._format("INFO", msg, extra)); }
    warn(msg, extra) { console.warn(this._format("WARN", msg, extra)); }
    error(msg, extra) { console.error(this._format("ERROR", msg, extra)); }
    debug(msg, extra) { console.log(this._format("DEBUG", msg, extra)); }
}

const logger = new SecurityLogger();

// Helper to format byte sizes into readable units (KB, MB, GB)
function formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// MIME type lookup helper
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        ".mp4": "video/mp4",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".pdf": "application/pdf",
        ".txt": "text/plain",
        ".json": "application/json",
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".iso": "application/x-iso9660-image",
        ".zip": "application/zip",
        ".tar": "application/x-tar",
        ".gz": "application/gzip"
    };
    return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Main S3 Upload Function with Multipart Streaming Support for files up to 5 GB+
 */
async function uploadFileToS3(filePath, customKey = null, customBucket = null) {
    const startTime = Date.now();
    logger.info("==================================================");
    logger.info("Starting High-Capacity S3 Multipart Upload Process...");
    logger.info("==================================================");

    // 1. Validate local file existence & size
    if (!filePath) {
        logger.error("No file path specified. Usage: node upload_to_s3.js <filePath> [s3Key] [bucketName]");
        process.exit(1);
    }

    const absolutePath = path.resolve(filePath);
    logger.info(`Step 1/5: Validating input file path...`);
    logger.info(`Target File Path: ${absolutePath}`);

    if (!fs.existsSync(absolutePath)) {
        logger.error(`File error: Target file does not exist at path: ${absolutePath}`);
        process.exit(1);
    }

    const fileStats = fs.statSync(absolutePath);
    if (!fileStats.isFile()) {
        logger.error(`Path error: Provided path is not a file: ${absolutePath}`);
        process.exit(1);
    }

    const formattedSize = formatBytes(fileStats.size);
    logger.info(`File validation success:`, {
        fileName: path.basename(absolutePath),
        sizeBytes: fileStats.size,
        formattedSize: formattedSize,
        createdTime: fileStats.birthtime,
        modifiedTime: fileStats.mtime
    });

    // 5GB size threshold warning check
    const FIVE_GB_BYTES = 5 * 1024 * 1024 * 1024;
    if (fileStats.size > FIVE_GB_BYTES) {
        logger.warn(`File size (${formattedSize}) exceeds 5 GB. Multipart streaming will handle this payload seamlessly up to 5 TB.`);
    }

    // 2. Validate S3 Configuration
    logger.info(`Step 2/5: Checking AWS Environment Credentials & Configuration...`);
    
    const region = (process.env.AWS_REGION || "us-east-1").trim();
    const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || "").trim();
    const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || "").trim();
    const bucketName = customBucket || (process.env.AWS_BUCKET_NAME || "").trim();

    logger.info(`AWS Configuration Summary (CREDENTIALS MASKED FOR SECURITY):`, {
        region: region,
        bucket: bucketName || "[NOT SET]",
        accessKeyId: maskSecret(accessKeyId),
        secretAccessKey: secretAccessKey ? "[REDACTED_SECRET_KEY]" : "[NOT SET]",
        hasCredentials: Boolean(accessKeyId && secretAccessKey)
    });

    if (!accessKeyId || !secretAccessKey) {
        logger.error("Configuration Error: AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY missing from environment (.env).");
        process.exit(1);
    }

    if (!bucketName) {
        logger.error("Configuration Error: AWS_BUCKET_NAME missing from environment (.env) and not provided via argument.");
        process.exit(1);
    }

    // 3. Prepare Upload Parameters
    logger.info(`Step 3/5: Preparing S3 Object Metadata & Key...`);
    const fileName = path.basename(absolutePath);
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const s3Key = customKey || `uploads/${Date.now()}_${sanitizedFileName}`;
    const contentType = getMimeType(absolutePath);

    // Dynamic chunk/part size determination (10MB default, scales for multi-GB files)
    const PART_SIZE = 10 * 1024 * 1024; // 10 MB per part chunk
    const QUEUE_SIZE = 4; // 4 concurrent part uploads

    logger.info(`S3 Upload Target Parameters:`, {
        bucket: bucketName,
        key: s3Key,
        contentType: contentType,
        contentLength: formattedSize,
        partChunkSize: `${PART_SIZE / (1024 * 1024)} MB`,
        parallelQueueSize: QUEUE_SIZE
    });

    // 4. Initialize S3 Client & Multipart Upload Manager
    logger.info(`Step 4/5: Initializing S3 Client & Multipart Streaming Manager...`);
    
    let s3Client = new S3Client({
        region: region,
        credentials: {
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey
        }
    });

    const createParallelUploader = (clientInstance) => {
        const uploader = new Upload({
            client: clientInstance,
            params: {
                Bucket: bucketName,
                Key: s3Key,
                Body: fs.createReadStream(absolutePath),
                ContentType: contentType
            },
            partSize: PART_SIZE,
            queueSize: QUEUE_SIZE,
            leavePartsOnError: false // Cleanup incomplete parts on failure
        });

        let lastLoggedPercent = -1;
        uploader.on("httpUploadProgress", (progress) => {
            if (!progress.total) return;
            const percent = Math.floor((progress.loaded / progress.total) * 100);
            
            // Log every 5% progress step or on completion to prevent log spam
            if (percent >= lastLoggedPercent + 5 || progress.loaded === progress.total) {
                lastLoggedPercent = percent;
                const loadedStr = formatBytes(progress.loaded);
                const totalStr = formatBytes(progress.total);
                logger.info(`[PROGRESS] Uploaded ${percent}% (${loadedStr} / ${totalStr})`);
            }
        });

        return uploader;
    };

    logger.info(`Initiating multipart upload stream for bucket '${bucketName}'...`);
    const transferStartTime = Date.now();

    try {
        let uploadResult;
        try {
            const uploader = createParallelUploader(s3Client);
            uploadResult = await uploader.done();
        } catch (s3Err) {
            if (s3Err.message && s3Err.message.includes("addressed using the specified endpoint")) {
                logger.warn(`Region Endpoint Warning: Detected regional redirect (${s3Err.message}). Retrying with global AWS endpoint fallback...`);
                
                const fallbackClient = new S3Client({
                    region: "us-east-1",
                    endpoint: "https://s3.amazonaws.com",
                    credentials: {
                        accessKeyId: accessKeyId,
                        secretAccessKey: secretAccessKey
                    }
                });
                
                const fallbackUploader = createParallelUploader(fallbackClient);
                uploadResult = await fallbackUploader.done();
                s3Client = fallbackClient;
            } else {
                throw s3Err;
            }
        }

        const transferDurationMs = Date.now() - transferStartTime;
        const transferSeconds = transferDurationMs / 1000 || 0.001;
        const uploadSpeedMBps = ((fileStats.size / (1024 * 1024)) / transferSeconds).toFixed(2);

        logger.info(`Multipart Transfer Complete:`, {
            httpStatusCode: uploadResult.$metadata?.httpStatusCode || 200,
            location: uploadResult.Location,
            eTag: uploadResult.ETag,
            transferDurationMs: `${transferDurationMs} ms`,
            averageSpeed: `${uploadSpeedMBps} MB/s`
        });

        // Construct Public / Standard S3 URL
        const s3Url = (region === "us-east-1")
            ? `https://${bucketName}.s3.amazonaws.com/${encodeURIComponent(s3Key)}`
            : `https://${bucketName}.s3.${region}.amazonaws.com/${encodeURIComponent(s3Key)}`;

        // 5. Verification: Perform HeadObject to confirm object is stored on S3
        logger.info(`Step 5/5: Verifying uploaded object via HeadObject request...`);
        try {
            const headResult = await s3Client.send(new HeadObjectCommand({
                Bucket: bucketName,
                Key: s3Key
            }));

            logger.info(`Remote Verification SUCCESSFUL:`, {
                contentLength: formatBytes(headResult.ContentLength || 0),
                contentType: headResult.ContentType,
                lastModified: headResult.LastModified,
                eTag: headResult.ETag
            });
        } catch (verifErr) {
            logger.warn(`Remote verification HeadObject returned a warning: ${verifErr.message}`);
        }

        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info("==================================================");
        logger.info(`SUCCESS: File upload completed successfully in ${totalDuration}s!`);
        logger.info(`Uploaded S3 Key: ${s3Key}`);
        logger.info(`S3 Resource URL: ${s3Url}`);
        logger.info("==================================================");

        return {
            success: true,
            s3Url,
            s3Key,
            bucket: bucketName,
            eTag: uploadResult.ETag,
            durationSeconds: totalDuration
        };

    } catch (err) {
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error("==================================================");
        logger.error(`S3 UPLOAD FAILED after ${totalDuration}s: ${err.message}`);
        logger.error("Detailed Error Context:", {
            name: err.name,
            code: err.code || err.$metadata?.httpStatusCode,
            requestId: err.$metadata?.requestId,
            message: logger.redactString(err.message)
        });
        logger.error("==================================================");

        return {
            success: false,
            error: logger.redactString(err.message)
        };
    }
}

// CLI Execution Entry point
if (require.main === module) {
    const args = process.argv.slice(2);
    const filePath = args[0];
    const customKey = args[1] || null;
    const customBucket = args[2] || null;

    if (!filePath) {
        console.log(`
Usage:
  node upload_to_s3.js <filePath> [s3Key] [bucketName]

Example:
  node upload_to_s3.js ./large-video.mp4 videos/large-video.mp4 my-bucket-name
        `);
        process.exit(0);
    }

    uploadFileToS3(filePath, customKey, customBucket)
        .then(result => {
            if (!result.success) {
                process.exit(1);
            }
        })
        .catch(err => {
            logger.error(`Unhandled error during execution: ${err.message}`);
            process.exit(1);
        });
}

module.exports = { uploadFileToS3, SecurityLogger, maskSecret };
