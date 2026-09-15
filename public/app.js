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
