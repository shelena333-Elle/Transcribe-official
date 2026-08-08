const API_URL = "http://127.0.0.1:5000";
const ACTIVE_JOB_KEY = "activeJobId";
const SPEED_MODE_KEY = "speedMode";

/** @type {{id:string,file:File,status:string,url:string,duration:string}[]} */
let queue = [];
let currentQueueIndex = -1;
let currentSegments = [];
let currentView = "raw";
let lastStructuredBlocks = null;
let activeXhr = null;
let activeJobId = null;
let busy = false;
let userStopped = false;
let stopQueue = false;
const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("audioFile");
const fileInfo = document.getElementById("fileInfo");
const backgroundHint = document.getElementById("backgroundHint");
const nameField = document.getElementById("name");
const sizeField = document.getElementById("size");
const durationField = document.getElementById("duration");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const progressBar = document.getElementById("progressBar");
const result = document.getElementById("result");
const structuredResult = document.getElementById("structuredResult");
const structuredPreview = document.getElementById("structuredPreview");
const structureButton = document.getElementById("structureButton");
const resultMeta = document.getElementById("resultMeta");
const queuePanel = document.getElementById("queuePanel");
const queueList = document.getElementById("queueList");
const queueMeta = document.getElementById("queueMeta");
const previewPanel = document.getElementById("previewPanel");
const audioPreview = document.getElementById("audioPreview");
const historyList = document.getElementById("historyList");

fileInput.addEventListener("change", (e) => addFiles([...e.target.files]));
fileInput.addEventListener("click", () => { fileInput.value = ""; });

dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("is-active");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("is-active");
});

dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("is-active");
    addFiles([...e.dataTransfer.files]);
});

function uid() {
    return Math.random().toString(36).slice(2, 10);
}

function formatSize(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function isAllowedAudio(file) {
    const allowed = [".mp3", ".wav", ".m4a"];
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
    return allowed.includes(extension);
}

function addFiles(files) {
    if (!files?.length || busy) return;

    const accepted = files.filter(isAllowedAudio);
    if (!accepted.length) {
        alert("Поддерживаются только MP3, WAV и M4A");
        return;
    }
    if (accepted.length < files.length) {
        alert("Часть файлов пропущена — нужны MP3, WAV или M4A");
    }

    for (const file of accepted) {
        const item = {
            id: uid(),
            file,
            status: "waiting",
            url: URL.createObjectURL(file),
            duration: "…",
        };
        queue.push(item);
        probeDuration(item);
    }

    if (currentQueueIndex < 0) {
        selectQueueItem(0);
    } else {
        renderQueue();
        syncControls();
    }
}

function probeDuration(item) {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = item.url;
    audio.addEventListener("loadedmetadata", () => {
        const minutes = Math.floor(audio.duration / 60);
        const seconds = Math.floor(audio.duration % 60);
        item.duration = `${minutes}:${seconds.toString().padStart(2, "0")}`;
        renderQueue();
        if (queue[currentQueueIndex]?.id === item.id) {
            durationField.textContent = item.duration;
        }
    });
}

function selectQueueItem(index) {
    if (index < 0 || index >= queue.length) return;
    currentQueueIndex = index;
    const item = queue[index];

    fileInfo.hidden = false;
    nameField.textContent = item.file.name;
    sizeField.textContent = formatSize(item.file.size);
    durationField.textContent = item.duration;

    previewPanel.hidden = false;
    audioPreview.pause();
    audioPreview.src = item.url;

    renderQueue();
    syncControls();
}

function removeQueueItem(id) {
    if (busy) return;
    const index = queue.findIndex((q) => q.id === id);
    if (index < 0) return;

    const [removed] = queue.splice(index, 1);
    if (removed?.url) URL.revokeObjectURL(removed.url);

    if (!queue.length) {
        clearQueueUI();
        return;
    }

    if (currentQueueIndex >= queue.length) {
        currentQueueIndex = queue.length - 1;
    } else if (index < currentQueueIndex) {
        currentQueueIndex -= 1;
    } else if (index === currentQueueIndex) {
        // stay on same index (next item slid in)
    }
    selectQueueItem(currentQueueIndex);
}

function clearQueueUI() {
    queue = [];
    currentQueueIndex = -1;
    fileInfo.hidden = true;
    previewPanel.hidden = true;
    queuePanel.hidden = true;
    queueList.innerHTML = "";
    nameField.textContent = "—";
    sizeField.textContent = "—";
    durationField.textContent = "—";
    audioPreview.pause();
    audioPreview.removeAttribute("src");
    audioPreview.load();
    syncControls();
}

function clearSelectedOrQueue() {
    if (busy) return;
    for (const item of queue) {
        if (item.url) URL.revokeObjectURL(item.url);
    }
    clearQueueUI();
    setProgress(0, "0%");
    showBackgroundHint(false);
    resultMeta.textContent = "Очередь очищена.";
}

function renderQueue() {
    if (!queue.length) {
        queuePanel.hidden = true;
        queueList.innerHTML = "";
        return;
    }

    queuePanel.hidden = false;
    const waiting = queue.filter((q) => q.status === "waiting" || q.status === "active").length;
    queueMeta.textContent = `${queue.length} файл(ов) · в работе/ожидании: ${waiting}`;

    queueList.innerHTML = queue.map((item, index) => {
        const statusLabel = {
            waiting: "В очереди",
            active: "Обрабатывается",
            done: "Готово",
            error: "Ошибка",
            cancelled: "Остановлено",
            partial: "Частично",
        }[item.status] || item.status;

        return `
            <li class="queue-item ${item.status === "active" ? "is-active" : ""} ${item.status === "done" || item.status === "partial" ? "is-done" : ""} ${item.status === "error" ? "is-error" : ""}" data-id="${item.id}">
                <div class="queue-item-main">
                    <span class="queue-item-name">${escapeHtml(item.file.name)}</span>
                    <span class="queue-item-meta">${formatSize(item.file.size)} · ${escapeHtml(item.duration)} · ${statusLabel}</span>
                </div>
                <div class="queue-item-actions">
                    <button type="button" class="btn-mini" data-action="preview" data-id="${item.id}">Слушать</button>
                    <button type="button" class="btn-mini" data-action="remove" data-id="${item.id}" ${busy ? "disabled" : ""}>✕</button>
                </div>
            </li>
        `;
    }).join("");
}

queueList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) {
        const row = e.target.closest(".queue-item");
        if (!row || busy) return;
        const index = queue.findIndex((q) => q.id === row.dataset.id);
        if (index >= 0) selectQueueItem(index);
        return;
    }

    const id = btn.dataset.id;
    if (btn.dataset.action === "remove") {
        removeQueueItem(id);
        return;
    }
    if (btn.dataset.action === "preview") {
        const index = queue.findIndex((q) => q.id === id);
        if (index >= 0) selectQueueItem(index);
    }
});

function setProgress(percent, label) {
    const value = Math.max(0, Math.min(100, percent));
    progressBar.style.width = value + "%";
    progressBar.textContent = label || value + "%";
}

function showBackgroundHint(visible) {
    backgroundHint.hidden = !visible;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function activeTextarea() {
    return currentView === "structured" ? structuredResult : result;
}

function syncStructureButton() {
    structureButton.disabled = !result.value.trim() || busy;
}

function syncControls() {
    const hasQueue = queue.length > 0;
    const hasWaiting = queue.some((q) => q.status === "waiting");
    startButton.disabled = busy || !hasWaiting;
    startButton.textContent = queue.filter((q) => q.status === "waiting").length > 1
        ? "Запустить очередь"
        : "Начать транскрибацию";

    const showStop = hasQueue || busy || Boolean(activeJobId);
    stopButton.hidden = !showStop;
    stopButton.disabled = false;
    stopButton.textContent = busy || activeJobId ? "Стоп" : "Удалить очередь";

    dropZone.style.pointerEvents = busy ? "none" : "";
    dropZone.style.opacity = busy ? "0.7" : "";
    document.querySelectorAll('input[name="speedMode"]').forEach((el) => {
        el.disabled = busy;
    });
    syncStructureButton();
}

function setBusy(value) {
    busy = value;
    syncControls();
    renderQueue();
}

function updateProgressFromJob(data) {
    if (data.status === "queued") {
        setProgress(20, data.message || "В очереди...");
    }
    if (data.status === "preparing" || data.status === "cancelling") {
        setProgress(25, data.message || "Подготовка...");
    }
    if (data.status === "processing") {
        if (data.chunk && data.total) {
            const percent = 25 + Math.round((data.chunk / data.total) * 70);
            setProgress(percent, data.message || `Часть ${data.chunk} из ${data.total}`);
        } else {
            setProgress(30, data.message || "Обработка...");
        }
        if (data.text) {
            result.value = data.text;
            syncStructureButton();
        }
    }
    if (data.status === "done") {
        setProgress(100, "Готово");
    }
    if (data.status === "cancelled") {
        setProgress(0, data.partial ? "Остановлено · частичный текст" : "Остановлено");
    }
}

function applyJobResult(data, { partial = false } = {}) {
    result.value = (data.text || "").trim();
    currentSegments = Array.isArray(data.segments) ? data.segments : [];
    syncStructureButton();

    if (partial && result.value) {
        resultMeta.textContent = data.result_file
            ? `Частичный результат сохранён: results\\${data.result_file}`
            : "Частичный результат сохранён.";
        backgroundHint.innerHTML = data.result_file
            ? `Остановлено. Уже распознанный текст сохранён в <b>results\\${data.result_file}</b>`
            : "Остановлено. Показан уже распознанный текст.";
        backgroundHint.hidden = false;
    } else if (result.value) {
        resultMeta.textContent = currentSegments.length
            ? `Готово: ${currentSegments.length} сегментов. Можно структурировать.`
            : "Готово. Можно структурировать текст.";
        if (data.result_file) {
            backgroundHint.innerHTML =
                `Готово! Текст также сохранён в файл: <b>results\\${data.result_file}</b>`;
            backgroundHint.hidden = false;
        }
    }
}

async function pollJob(jobId) {
    activeJobId = jobId;
    syncControls();

    while (true) {
        if (userStopped) {
            // дождёмся финального cancelled со стороны сервера (с partial text)
        }

        const response = await fetch(`${API_URL}/jobs/${jobId}`);

        if (response.status === 404) {
            throw new Error("Задача не найдена. Возможно, сервер перезапускали — проверьте папку results.");
        }

        const data = await response.json();
        updateProgressFromJob(data);

        if (data.status === "done") {
            localStorage.removeItem(ACTIVE_JOB_KEY);
            activeJobId = null;
            applyJobResult(data);
            return data;
        }

        if (data.status === "cancelled") {
            localStorage.removeItem(ACTIVE_JOB_KEY);
            activeJobId = null;
            applyJobResult(data, { partial: Boolean(data.text) });
            const err = new Error("Остановлено пользователем");
            err.partialData = data;
            throw err;
        }

        if (data.status === "error") {
            throw new Error(data.error || "Ошибка транскрибации");
        }

        await sleep(2000);
    }
}

function uploadFile(formData) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeXhr = xhr;
        xhr.open("POST", `${API_URL}/transcribe`);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                const uploadPercent = Math.round((event.loaded / event.total) * 100);
                const barPercent = Math.max(5, Math.round(uploadPercent * 0.2));
                setProgress(barPercent, `Отправка файла... ${uploadPercent}%`);
            }
        };

        xhr.onload = () => {
            activeXhr = null;
            try {
                const data = JSON.parse(xhr.responseText);
                if (xhr.status >= 400) {
                    reject(new Error(data.error || "Ошибка сервера"));
                    return;
                }
                if (!data.job_id) {
                    reject(new Error("Старый сервер. Закройте чёрное окно и запустите start.bat заново."));
                    return;
                }
                resolve(data);
            } catch (_) {
                reject(new Error("Сервер ответил неверно. Перезапустите start.bat."));
            }
        };

        xhr.onerror = () => {
            activeXhr = null;
            reject(new Error("Нет связи с сервером. Запустите start.bat."));
        };

        xhr.onabort = () => {
            activeXhr = null;
            reject(new Error("Остановлено пользователем"));
        };

        xhr.send(formData);
    });
}

async function cancelActiveJob() {
    const jobId = activeJobId || localStorage.getItem(ACTIVE_JOB_KEY);
    if (!jobId) return null;

    try {
        await fetch(`${API_URL}/jobs/${jobId}/cancel`, { method: "POST" });
    } catch (_) {
        // ignore
    }
    return jobId;
}

async function stopOrClear() {
    if (!busy && !activeJobId) {
        clearSelectedOrQueue();
        return;
    }

    userStopped = true;
    stopQueue = true;
    stopButton.disabled = true;
    stopButton.textContent = "Остановка…";
    setProgress(Math.max(5, parseInt(progressBar.style.width, 10) || 5), "Остановка…");

    if (activeXhr) {
        activeXhr.abort();
    }

    await cancelActiveJob();
}

function getSpeedMode() {
    const selected = document.querySelector('input[name="speedMode"]:checked');
    return selected?.value === "fast" ? "fast" : "accurate";
}

function initSpeedMode() {
    const saved = localStorage.getItem(SPEED_MODE_KEY);
    const value = saved === "fast" || saved === "accurate" ? saved : "accurate";
    const input = document.querySelector(`input[name="speedMode"][value="${value}"]`);
    if (input) input.checked = true;

    document.querySelectorAll('input[name="speedMode"]').forEach((radio) => {
        radio.addEventListener("change", () => {
            localStorage.setItem(SPEED_MODE_KEY, getSpeedMode());
        });
    });
}

async function checkServer() {
    try {
        const response = await fetch(`${API_URL}/health`);
        const data = await response.json();
        if (!data.chunk_minutes) {
            alert("Сервер устаревший. Закройте все чёрные окна и запустите start.bat заново.");
        }
        if (!data.features || !data.features.includes("history")) {
            alert("Сервер устарел. Закройте чёрное окно и запустите start.bat заново.");
        }
    } catch (_) {
        alert("Сервер не запущен. Запустите start.bat.");
    }
}

async function processOneFile(item, mode) {
    item.status = "active";
    currentQueueIndex = queue.findIndex((q) => q.id === item.id);
    selectQueueItem(currentQueueIndex);
    renderQueue();

    const formData = new FormData();
    formData.append("file", item.file);
    formData.append("language", "ru");
    formData.append("mode", mode);

    setProgress(5, `Отправка: ${item.file.name}`);
    const data = await uploadFile(formData);

    if (userStopped) {
        activeJobId = data.job_id;
        await cancelActiveJob();
        // подождём cancelled + partial
        try {
            return await pollJob(data.job_id);
        } catch (err) {
            throw err;
        }
    }

    localStorage.setItem(ACTIVE_JOB_KEY, data.job_id);
    activeJobId = data.job_id;
    showBackgroundHint(true);
    const modeLabel = mode === "fast" ? "быстрее" : "точнее";
    setProgress(22, `${item.file.name} · ${modeLabel}`);
    return pollJob(data.job_id);
}

async function startTranscription() {
    if (busy) return;
    const pending = queue.filter((q) => q.status === "waiting");
    if (!pending.length) return;

    userStopped = false;
    stopQueue = false;
    setBusy(true);
    structuredResult.value = "";
    structuredPreview.innerHTML = "";
    structuredPreview.hidden = true;
    lastStructuredBlocks = null;

    const mode = getSpeedMode();
    localStorage.setItem(SPEED_MODE_KEY, mode);

    try {
        for (const item of pending) {
            if (stopQueue || userStopped) break;

            result.value = "";
            currentSegments = [];
            resultMeta.textContent = `Обработка: ${item.file.name}`;

            try {
                await processOneFile(item, mode);
                item.status = "done";
            } catch (error) {
                if (userStopped || /остановлено/i.test(error.message || "")) {
                    item.status = error.partialData?.text ? "partial" : "cancelled";
                    if (error.partialData) {
                        applyJobResult(error.partialData, { partial: Boolean(error.partialData.text) });
                    }
                    break;
                }
                item.status = "error";
                resultMeta.textContent = `Ошибка: ${item.file.name}`;
                alert(`Не удалось: ${item.file.name}\n\n${error.message}`);
                // продолжаем следующий файл в очереди
            } finally {
                renderQueue();
                loadHistory();
            }
        }

        if (!userStopped && !stopQueue) {
            const doneCount = queue.filter((q) => q.status === "done").length;
            if (doneCount > 1) {
                resultMeta.textContent = `Очередь завершена: ${doneCount} файл(ов). Показан последний результат.`;
            }
            setProgress(100, "Готово");
        } else if (!result.value) {
            setProgress(0, "Остановлено");
            resultMeta.textContent = "Очередь остановлена.";
        }
    } finally {
        activeXhr = null;
        activeJobId = null;
        localStorage.removeItem(ACTIVE_JOB_KEY);
        setBusy(false);
        userStopped = false;
        stopQueue = false;
        showBackgroundHint(Boolean(backgroundHint.textContent && !backgroundHint.hidden));
    }
}

function parseSpeakerNames() {
    const raw = document.getElementById("speakerNames").value || "";
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function renderStructuredPreview(blocks) {
    if (!blocks || !blocks.length) {
        structuredPreview.hidden = true;
        structuredPreview.innerHTML = "";
        return;
    }

    const html = blocks.map((block) => {
        const turns = (block.turns || []).map((turn) => `
            <div class="turn">
                <div class="turn-speaker">${escapeHtml(turn.speaker || "Спикер")}</div>
                <div class="turn-text">${escapeHtml(turn.text || "")}</div>
            </div>
        `).join("");

        return `
            <article class="block-card">
                <h3>${escapeHtml(block.title || "Блок")}</h3>
                ${turns}
            </article>
        `;
    }).join("");

    structuredPreview.innerHTML = html;
    structuredPreview.hidden = currentView !== "structured";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

async function structureText() {
    const text = result.value.trim();
    if (!text) {
        alert("Сначала получите или вставьте текст транскрипта.");
        return;
    }

    structureButton.disabled = true;
    resultMeta.textContent = "Структурируем…";

    const payload = {
        text,
        segments: currentSegments,
        speakers: parseSpeakerNames(),
        speaker_count: Number(document.getElementById("speakerCount").value) || 2,
        thematic: document.getElementById("thematicBlocks").checked,
        include_timestamps: document.getElementById("includeTimestamps").checked,
        topic_minutes: Number(document.getElementById("topicMinutes").value) || 6,
    };

    try {
        const response = await fetch(`${API_URL}/structure`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || "Ошибка структурирования");
        }

        structuredResult.value = data.plain_text || "";
        lastStructuredBlocks = data.blocks || [];
        renderStructuredPreview(lastStructuredBlocks);
        setView("structured");
        resultMeta.textContent =
            `Структура: ${data.block_count || 0} блоков, ${data.turn_count || 0} реплик` +
            (data.result_file ? ` · сохранено в results\\${data.result_file}` : "");
        loadHistory();
    } catch (error) {
        alert(error.message || "Не удалось структурировать");
        resultMeta.textContent = "Не удалось структурировать текст.";
    } finally {
        syncStructureButton();
    }
}

function setView(view) {
    currentView = view;
    document.querySelectorAll(".tab").forEach((tab) => {
        const active = tab.dataset.view === view;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    result.hidden = view !== "raw";
    structuredResult.hidden = view !== "structured";
    structuredPreview.hidden = view !== "structured" || !lastStructuredBlocks;
}

async function exportCurrent(format) {
    const text = activeTextarea().value.trim();
    if (!text) {
        alert("Нет текста для выгрузки.");
        return;
    }

    if (format === "txt") {
        downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), "transcription.txt");
        return;
    }

    const current = queue[currentQueueIndex];
    const title = current ? current.file.name.replace(/\.[^.]+$/, "") : "Транскрипт";

    try {
        const response = await fetch(`${API_URL}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, format, title }),
        });

        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new Error(data.error || "Ошибка экспорта");
        }

        const blob = await response.blob();
        const disposition = response.headers.get("Content-Disposition") || "";
        const match = /filename="?([^"]+)"?/i.exec(disposition);
        const filename = match?.[1] || (format === "pdf" ? "transcription.pdf" : "transcription.docx");
        downloadBlob(blob, filename);
    } catch (error) {
        alert(error.message || "Не удалось выгрузить файл");
    }
}

function downloadBlob(blob, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function loadHistory() {
    try {
        const response = await fetch(`${API_URL}/results`);
        if (!response.ok) throw new Error("history");
        const data = await response.json();
        const items = data.items || [];

        if (!items.length) {
            historyList.innerHTML = `<li class="history-empty">Пока пусто — появятся после первой транскрибации.</li>`;
            return;
        }

        historyList.innerHTML = items.map((item) => `
            <li class="history-item">
                <div class="history-item-main">
                    <span class="history-item-name">
                        ${escapeHtml(item.name)}
                        ${item.partial ? '<span class="badge">частичный</span>' : ""}
                    </span>
                    <span class="history-item-meta">${escapeHtml(item.mtime)} · ${formatBytes(item.size)}</span>
                </div>
                <div class="history-item-actions">
                    <button type="button" class="btn-mini" data-history="${escapeHtml(item.name)}">Открыть</button>
                </div>
            </li>
        `).join("");
    } catch (_) {
        historyList.innerHTML = `<li class="history-empty">Не удалось загрузить историю. Проверьте, что сервер запущен.</li>`;
    }
}

historyList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-history]");
    if (!btn) return;
    const name = btn.dataset.history;
    try {
        const response = await fetch(`${API_URL}/results/${encodeURIComponent(name)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Не найден");
        result.value = data.text || "";
        currentSegments = Array.isArray(data.segments) ? data.segments : [];
        structuredResult.value = "";
        lastStructuredBlocks = null;
        structuredPreview.hidden = true;
        setView("raw");
        syncStructureButton();
        resultMeta.textContent = `Открыто из истории: ${name}`;
        showBackgroundHint(false);
    } catch (error) {
        alert(error.message || "Не удалось открыть файл");
    }
});

async function cleanupCache() {
    if (!confirm("Очистить временные файлы в папке jobs? Готовые тексты в results останутся.")) {
        return;
    }
    try {
        const response = await fetch(`${API_URL}/cleanup`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Ошибка очистки");
        alert(
            `${data.message || "Готово"}\nУдалено папок jobs: ${data.removed_job_dirs || 0}\n` +
            `Освобождено ≈ ${formatBytes(data.freed_bytes || 0)}`
        );
    } catch (error) {
        alert(error.message || "Не удалось очистить кэш");
    }
}

startButton.addEventListener("click", startTranscription);
stopButton.addEventListener("click", stopOrClear);
structureButton.addEventListener("click", structureText);
result.addEventListener("input", syncStructureButton);
document.getElementById("refreshHistory").addEventListener("click", loadHistory);
document.getElementById("cleanupButton").addEventListener("click", cleanupCache);

document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
});

document.getElementById("copy").addEventListener("click", () => {
    navigator.clipboard.writeText(activeTextarea().value);
});

document.getElementById("txt").addEventListener("click", () => exportCurrent("txt"));
document.getElementById("doc").addEventListener("click", () => exportCurrent("docx"));
document.getElementById("pdf").addEventListener("click", () => exportCurrent("pdf"));

initSpeedMode();
syncControls();
checkServer();
loadHistory();

const savedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
if (savedJobId) {
    userStopped = false;
    activeJobId = savedJobId;
    setBusy(true);
    showBackgroundHint(true);
    setProgress(10, "Продолжаем фоновую обработку...");
    pollJob(savedJobId)
        .then(() => loadHistory())
        .catch((error) => {
            if (userStopped || /остановлено/i.test(error.message || "")) {
                if (error.partialData) {
                    applyJobResult(error.partialData, { partial: Boolean(error.partialData.text) });
                } else {
                    setProgress(0, "Остановлено");
                    resultMeta.textContent = "Обработка остановлена.";
                }
            } else {
                setProgress(0, "0%");
                alert(error.message);
            }
        })
        .finally(() => {
            activeJobId = null;
            setBusy(false);
            userStopped = false;
            loadHistory();
        });
}
