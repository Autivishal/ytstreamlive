/**
 * YTLive Control Center - Client Application
 */

document.addEventListener("DOMContentLoaded", () => {
    // DOM Element References
    const serverBadge = document.getElementById("server-badge");
    const serverStatusText = document.getElementById("server-status-text");
    const streamBadge = document.getElementById("stream-badge");
    const streamStatusText = document.getElementById("stream-status-text");

    const inputToken = document.getElementById("input-token");
    const inputVideoUrl = document.getElementById("input-video-url");
    const inputStreamKey = document.getElementById("input-stream-key");

    const btnStart = document.getElementById("btn-start");
    const btnStop = document.getElementById("btn-stop");
    const btnCheckFfmpeg = document.getElementById("btn-check-ffmpeg");
    const btnClearLogs = document.getElementById("btn-clear-logs");
    const btnRememberToggle = document.getElementById("btn-remember-toggle");

    const metricStatusVal = document.getElementById("metric-status-val");
    const metricUptimeVal = document.getElementById("metric-uptime-val");
    const diagFfmpegVersion = document.getElementById("diag-ffmpeg-version");
    const consoleLogs = document.getElementById("console-logs");
    const logOrigin = document.getElementById("log-origin");

    let isStreamRunning = false;
    let localTimerInterval = null;
    let currentUptimeSeconds = 0;

    // Set server origin in console header
    if (logOrigin) {
        logOrigin.textContent = window.location.origin;
    }

    // Load credentials from localStorage if available
    loadStoredCredentials();

    // -------------------------------------------------------------------------
    // Logging Utility
    // -------------------------------------------------------------------------
    function log(message, type = "info") {
        const timeStr = new Date().toLocaleTimeString();
        const line = document.createElement("div");
        line.className = `log-line log-${type}`;
        line.textContent = `[${timeStr}] ${message}`;
        consoleLogs.appendChild(line);
        consoleLogs.scrollTop = consoleLogs.scrollHeight;
    }

    // -------------------------------------------------------------------------
    // LocalStorage Credentials Helper
    // -------------------------------------------------------------------------
    function loadStoredCredentials() {
        const savedToken = localStorage.getItem("ytlive_token");
        const savedStreamKey = localStorage.getItem("ytlive_stream_key");
        const savedVideoUrl = localStorage.getItem("ytlive_video_url");

        if (savedToken) inputToken.value = savedToken;
        if (savedStreamKey) inputStreamKey.value = savedStreamKey;
        if (savedVideoUrl) inputVideoUrl.value = savedVideoUrl;
    }

    function saveCredentials() {
        if (inputToken.value.trim()) {
            localStorage.setItem("ytlive_token", inputToken.value.trim());
        }
        if (inputStreamKey.value.trim()) {
            localStorage.setItem("ytlive_stream_key", inputStreamKey.value.trim());
        }
        if (inputVideoUrl.value.trim()) {
            localStorage.setItem("ytlive_video_url", inputVideoUrl.value.trim());
        }
        log("Saved configuration to browser local storage", "system");
    }

    btnRememberToggle?.addEventListener("click", () => {
        saveCredentials();
        alert("Credentials saved to local storage!");
    });

    // -------------------------------------------------------------------------
    // Password Visibility Toggles
    // -------------------------------------------------------------------------
    document.querySelectorAll(".toggle-password").forEach(btn => {
        btn.addEventListener("click", () => {
            const targetId = btn.getAttribute("data-target");
            const targetInput = document.getElementById(targetId);
            if (targetInput) {
                const isPassword = targetInput.type === "password";
                targetInput.type = isPassword ? "text" : "password";
                btn.style.color = isPassword ? "var(--accent-red)" : "var(--text-muted)";
            }
        });
    });

    // -------------------------------------------------------------------------
    // Sample Video Link Autofill
    // -------------------------------------------------------------------------
    document.querySelectorAll(".btn-chip").forEach(chip => {
        chip.addEventListener("click", () => {
            const sampleUrl = chip.getAttribute("data-url");
            if (sampleUrl) {
                inputVideoUrl.value = sampleUrl;
                log(`Selected sample video source: ${chip.textContent}`, "info");
            }
        });
    });

    // -------------------------------------------------------------------------
    // Time Formatter (seconds to HH:MM:SS)
    // -------------------------------------------------------------------------
    function formatTime(seconds) {
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        return [hrs, mins, secs]
            .map(v => v.toString().padStart(2, "0"))
            .join(":");
    }

    // -------------------------------------------------------------------------
    // Stream Status UI Update
    // -------------------------------------------------------------------------
    function updateUIStatus(running, uptimeSeconds = 0) {
        isStreamRunning = running;

        if (running) {
            serverBadge.classList.add("online");
            serverStatusText.textContent = "Online";

            streamBadge.className = "stream-badge status-live";
            streamStatusText.textContent = "LIVE";

            metricStatusVal.textContent = "LIVE";
            metricStatusVal.style.color = "var(--accent-red)";

            btnStart.disabled = true;
            btnStop.disabled = false;

            currentUptimeSeconds = uptimeSeconds;
            metricUptimeVal.textContent = formatTime(currentUptimeSeconds);
        } else {
            serverBadge.classList.add("online");
            serverStatusText.textContent = "Online";

            streamBadge.className = "stream-badge status-offline";
            streamStatusText.textContent = "OFFLINE";

            metricStatusVal.textContent = "OFFLINE";
            metricStatusVal.style.color = "var(--text-muted)";

            btnStart.disabled = false;
            btnStop.disabled = true;

            currentUptimeSeconds = 0;
            metricUptimeVal.textContent = "00:00:00";
        }
    }

    // -------------------------------------------------------------------------
    // API Call: Check Server Health & Stream Status
    // -------------------------------------------------------------------------
    async function checkHealth() {
        try {
            const response = await fetch("/health");
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            
            updateUIStatus(data.running, data.uptime || 0);
        } catch (err) {
            serverBadge.classList.remove("online");
            serverStatusText.textContent = "Disconnected";
            log(`Server health check failed: ${err.message}`, "error");
        }
    }

    // -------------------------------------------------------------------------
    // API Call: Check FFmpeg Version
    // -------------------------------------------------------------------------
    async function checkFFmpeg() {
        diagFfmpegVersion.textContent = "Checking...";
        log("Checking FFmpeg binary version...", "info");

        try {
            const response = await fetch("/ffmpeg-check");
            const data = await response.json();

            if (data.success) {
                diagFfmpegVersion.textContent = data.output || "Available";
                log(`FFmpeg status: OK (${data.output || "Ready"})`, "success");
            } else {
                diagFfmpegVersion.textContent = "Error";
                log(`FFmpeg check failed: ${data.error || "Unknown error"}`, "error");
            }
        } catch (err) {
            diagFfmpegVersion.textContent = "Unavailable";
            log(`FFmpeg check endpoint error: ${err.message}`, "error");
        }
    }

    btnCheckFfmpeg?.addEventListener("click", checkFFmpeg);

    // -------------------------------------------------------------------------
    // API Call: Start Stream
    // -------------------------------------------------------------------------
    btnStart?.addEventListener("click", async () => {
        const token = inputToken.value.trim();
        const videoUrl = inputVideoUrl.value.trim();
        const streamKey = inputStreamKey.value.trim();

        if (!token) {
            alert("Please enter your API Security Token.");
            inputToken.focus();
            return;
        }

        if (!videoUrl) {
            alert("Please enter a Video Source URL.");
            inputVideoUrl.focus();
            return;
        }

        if (!streamKey) {
            alert("Please enter your YouTube Stream Key.");
            inputStreamKey.focus();
            return;
        }

        // Save credentials automatically on submit
        saveCredentials();

        btnStart.disabled = true;
        log("Initiating live stream to YouTube...", "info");

        try {
            const response = await fetch("/start-stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, videoUrl, streamKey })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                log(`Stream launched successfully! ${data.message}`, "success");
                updateUIStatus(true, 0);
            } else {
                let errorMsg = `Start stream failed: ${data.message || response.statusText}`;
                if (response.status === 401) {
                    errorMsg += " (Token mismatch. Make sure your input matches API_TOKEN in server .env)";
                }
                log(errorMsg, "error");
                btnStart.disabled = false;
            }
        } catch (err) {
            log(`Network error starting stream: ${err.message}`, "error");
            btnStart.disabled = false;
        }
    });

    // -------------------------------------------------------------------------
    // API Call: Stop Stream
    // -------------------------------------------------------------------------
    btnStop?.addEventListener("click", async () => {
        const token = inputToken.value.trim();

        if (!token) {
            alert("Please enter your API Security Token to stop the stream.");
            inputToken.focus();
            return;
        }

        if (!confirm("Are you sure you want to stop the live stream?")) {
            return;
        }

        btnStop.disabled = true;
        log("Sending stop stream command...", "warning");

        try {
            const response = await fetch("/stop-stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                log("Stream stopped successfully.", "success");
                updateUIStatus(false, 0);
            } else {
                log(`Stop stream failed: ${data.message || response.statusText}`, "error");
                btnStop.disabled = false;
            }
        } catch (err) {
            log(`Network error stopping stream: ${err.message}`, "error");
            btnStop.disabled = false;
        }
    });

    // -------------------------------------------------------------------------
    // AWS S3 File Upload System
    // -------------------------------------------------------------------------
    const s3Dropzone = document.getElementById("s3-dropzone");
    const s3FileInput = document.getElementById("s3-file-input");
    const btnBrowseFile = document.getElementById("btn-browse-file");
    const filePreviewBar = document.getElementById("file-preview-bar");
    const s3FileName = document.getElementById("s3-file-name");
    const s3FileSize = document.getElementById("s3-file-size");
    const btnRemoveFile = document.getElementById("btn-remove-file");
    const btnUploadS3 = document.getElementById("btn-upload-s3");

    const uploadProgressContainer = document.getElementById("upload-progress-container");
    const uploadStatusText = document.getElementById("upload-status-text");
    const uploadPercentage = document.getElementById("upload-percentage");
    const uploadProgressBar = document.getElementById("upload-progress-bar");

    const s3ResultCard = document.getElementById("s3-result-card");
    const s3ResultUrl = document.getElementById("s3-result-url");
    const btnCopyS3Url = document.getElementById("btn-copy-s3-url");
    const btnUseS3Url = document.getElementById("btn-use-s3-url");

    let selectedVideoFile = null;

    function formatBytes(bytes) {
        if (bytes === 0) return "0 Bytes";
        const k = 1024;
        const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    }

    function handleFileSelection(file) {
        if (!file) return;

        // Check if file is a video
        if (!file.type.startsWith("video/") && !/\.(mp4|mkv|mov|flv|webm|ts)$/i.test(file.name)) {
            alert("Please select a valid video file (.mp4, .mkv, .mov, .webm).");
            return;
        }

        const formattedSize = formatBytes(file.size);
        selectedVideoFile = file;
        s3FileName.textContent = file.name;
        s3FileSize.textContent = formattedSize;

        filePreviewBar.classList.remove("hidden");
        btnUploadS3.disabled = false;
        s3ResultCard.classList.add("hidden");
        uploadProgressContainer.classList.add("hidden");

        log(`Selected video for S3 upload: ${file.name} (${formattedSize})`, "info");
    }

    function resetFileSelection() {
        selectedVideoFile = null;
        s3FileInput.value = "";
        filePreviewBar.classList.add("hidden");
        btnUploadS3.disabled = true;
        uploadProgressContainer.classList.add("hidden");
    }

    btnBrowseFile?.addEventListener("click", (e) => {
        e.stopPropagation();
        s3FileInput.click();
    });

    s3Dropzone?.addEventListener("click", () => {
        s3FileInput.click();
    });

    s3FileInput?.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
    });

    // Drag and drop handlers
    ["dragenter", "dragover"].forEach(eventName => {
        s3Dropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            s3Dropzone.classList.add("dragover");
        });
    });

    ["dragleave", "drop"].forEach(eventName => {
        s3Dropzone?.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
            s3Dropzone.classList.remove("dragover");
        });
    });

    s3Dropzone?.addEventListener("drop", (e) => {
        const dt = e.dataTransfer;
        if (dt.files && dt.files[0]) {
            handleFileSelection(dt.files[0]);
        }
    });

    btnRemoveFile?.addEventListener("click", resetFileSelection);

    // Upload to AWS S3 via XHR (supports progress tracking)
    btnUploadS3?.addEventListener("click", () => {
        if (!selectedVideoFile) return;

        const token = inputToken.value.trim();
        if (!token) {
            alert("Please enter your API Security Token first.");
            inputToken.focus();
            return;
        }

        btnUploadS3.disabled = true;
        uploadProgressContainer.classList.remove("hidden");
        uploadProgressBar.style.width = "0%";
        uploadPercentage.textContent = "0%";
        uploadStatusText.textContent = "Uploading to S3...";

        log(`Starting upload of ${selectedVideoFile.name} to AWS S3...`, "info");

        const formData = new FormData();
        formData.append("token", token);
        formData.append("videoFile", selectedVideoFile);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/upload-s3", true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                uploadProgressBar.style.width = `${percent}%`;
                uploadPercentage.textContent = `${percent}%`;
                uploadStatusText.textContent = percent === 100 ? "Processing on S3..." : `Uploading (${percent}%)...`;
            }
        };

        xhr.onload = () => {
            let response;
            try {
                response = JSON.parse(xhr.responseText);
            } catch (err) {
                const cleanMsg = xhr.responseText.replace(/<[^>]*>/g, '').trim().slice(0, 150);
                const errorStr = cleanMsg || `Server returned non-JSON response (HTTP ${xhr.status})`;
                log(`S3 upload error (HTTP ${xhr.status}): ${errorStr}`, "error");
                alert(`S3 Upload Error (HTTP ${xhr.status}): ${errorStr}`);
                btnUploadS3.disabled = false;
                return;
            }

            if (xhr.status === 200 && response.success) {
                uploadProgressBar.style.width = "100%";
                uploadPercentage.textContent = "100%";
                uploadStatusText.textContent = "Upload complete!";

                s3ResultUrl.value = response.url;
                s3ResultCard.classList.remove("hidden");

                log(`File successfully uploaded to AWS S3: ${response.url}`, "success");
            } else {
                log(`S3 upload failed: ${response.message || "Server error"}`, "error");
                alert(`S3 Upload Failed: ${response.message || "Check server logs for details."}`);
                btnUploadS3.disabled = false;
            }
        };

        xhr.onerror = () => {
            log("Network error during S3 upload.", "error");
            alert("Network error while uploading to S3.");
            btnUploadS3.disabled = false;
        };

        xhr.send(formData);
    });

    // Copy S3 URL
    btnCopyS3Url?.addEventListener("click", () => {
        if (!s3ResultUrl.value) return;
        navigator.clipboard.writeText(s3ResultUrl.value);
        btnCopyS3Url.textContent = "Copied!";
        setTimeout(() => { btnCopyS3Url.textContent = "Copy"; }, 2000);
        log("Copied S3 video URL to clipboard", "info");
    });

    // Set as Stream Source URL
    btnUseS3Url?.addEventListener("click", () => {
        if (!s3ResultUrl.value) return;
        inputVideoUrl.value = s3ResultUrl.value;
        log("Set S3 video URL as stream source", "success");

        // Scroll smoothly to Stream Configuration
        document.querySelector(".control-card")?.scrollIntoView({ behavior: "smooth" });
    });

    // Clear Logs Button
    btnClearLogs?.addEventListener("click", () => {
        consoleLogs.innerHTML = "";
        log("Console logs cleared", "system");
    });

    // Initial Health Check & Automatic Polling Loop (every 3s)
    checkHealth();
    checkFFmpeg();
    setInterval(checkHealth, 3000);
});
