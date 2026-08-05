const API_URL = "http://127.0.0.1:5000";
const ACTIVE_JOB_KEY = "activeJobId";
const SPEED_MODE_KEY = "speedMode";

let selectedFile = null;
let currentSegments = [];
let currentView = "raw";
let lastStructuredBlocks = null;

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("audioFile");
const fileInfo = document.getElementById("fileInfo");
const backgroundHint = document.getElementById("backgroundHint");
const nameField = document.getElementById("name");
const sizeField = document.getElementById("size");
const durationField = document.getElementById("duration");
const startButton = document.getElementById("startButton");
const progressBar = document.getElementById("progressBar");
const result = document.getElementById("result");
const structuredResult = document.getElementById("structuredResult");
const structuredPreview = document.getElementById("structuredPreview");
const structureButton = document.getElementById("structureButton");
const resultMeta = document.getElementById("resultMeta");

fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

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
    handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
    if (!file) return;

    const allowed = [".mp3", ".wav", ".m4a"];
    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();

    if (!allowed.includes(extension)) {
        alert("Поддерживаются только MP3, WAV и M4A");
        return;
    }

    selectedFile = file;
    fileInfo.hidden = false;
    nameField.textContent = file.name;
    sizeField.textContent = (file.size / 1024 / 1024).toFixed(2) + " MB";
    getDuration(file);
    startButton.disabled = false;
}

function getDuration(file) {
    const audio = document.createElement("audio");
    audio.src = URL.createObjectURL(file);
    audio.addEventListener("loadedmetadata", () => {
        const minutes = Math.floor(audio.duration / 60);
        const seconds = Math.floor(audio.duration % 60);
        durationField.textContent = `${minutes}:${seconds.toString().padStart(2, "0")}`;
        URL.revokeObjectURL(audio.src);
    });
}

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
    structureButton.disabled = !result.value.trim();
}

function updateProgressFromJob(data) {
    if (data.status === "queued") {
        setProgress(20, data.message || "В очереди...");
    }
    if (data.status === "preparing") {
        setProgress(25, data.message || "Подготовка...");
    }
    if (data.status === "processing") {
        if (data.chunk && data.total) {
            const percent = 25 + Math.round((data.chunk / data.total) * 70);
            setProgress(percent, data.message || `Часть ${data.chunk} из ${data.total}`);
        } else {
            setProgress(30, data.message || "Обработка...");
        }
    }
    if (data.status === "done") {
        setProgress(100, "Готово");
    }
}

async function pollJob(jobId) {
    while (true) {
        const response = await fetch(`${API_URL}/jobs/${jobId}`);

        if (response.status === 404) {
            throw new Error("Задача не найдена. Возможно, сервер перезапускали — проверьте папку results.");
        }

        const data = await response.json();
        updateProgressFromJob(data);

        if (data.status === "done") {
            result.value = (data.text || "").trim();
            currentSegments = Array.isArray(data.segments) ? data.segments : [];
            localStorage.removeItem(ACTIVE_JOB_KEY);
            showBackgroundHint(false);
            syncStructureButton();
            resultMeta.textContent = currentSegments.length
                ? `Готово: ${currentSegments.length} сегментов. Можно структурировать.`
                : "Готово. Можно структурировать текст.";

            if (data.result_file) {
                backgroundHint.innerHTML =
                    `Готово! Текст также сохранён в файл: <b>results\\${data.result_file}</b>`;
                backgroundHint.hidden = false;
            }
            return;
        }

        if (data.status === "error") {
            throw new Error(data.error || "Ошибка транскрибации");
        }

        await sleep(5000);
    }
}

function uploadFile(formData) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_URL}/transcribe`);

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                const uploadPercent = Math.round((event.loaded / event.total) * 100);
                const barPercent = Math.max(5, Math.round(uploadPercent * 0.2));
                setProgress(barPercent, `Отправка файла... ${uploadPercent}%`);
            }
        };

        xhr.onload = () => {
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

        xhr.onerror = () => reject(new Error("Нет связи с сервером. Запустите start.bat."));
        xhr.send(formData);
    });
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
        if (!data.features || !data.features.includes("speed_mode")) {
            alert("Сервер без переключателя скорости. Закройте чёрное окно и запустите start.bat заново.");
        }
    } catch (_) {
        alert("Сервер не запущен. Запустите start.bat.");
    }
}

async function startTranscription() {
    if (!selectedFile) return;

    startButton.disabled = true;
    structureButton.disabled = true;
    result.value = "";
    structuredResult.value = "";
    structuredPreview.innerHTML = "";
    structuredPreview.hidden = true;
    currentSegments = [];
    lastStructuredBlocks = null;
    setProgress(5, "Отправка файла... 0%");

    const mode = getSpeedMode();
    localStorage.setItem(SPEED_MODE_KEY, mode);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("language", "ru");
    formData.append("mode", mode);

    try {
        const data = await uploadFile(formData);
        localStorage.setItem(ACTIVE_JOB_KEY, data.job_id);
        showBackgroundHint(true);
        const modeLabel = mode === "fast" ? "быстрее" : "точнее";
        setProgress(22, `Файл принят (${modeLabel}), идёт обработка...`);
        await pollJob(data.job_id);
    } catch (error) {
        setProgress(0, "0%");
        result.value = "";
        localStorage.removeItem(ACTIVE_JOB_KEY);
        showBackgroundHint(false);
        alert(
            "Не удалось транскрибировать.\n\n" +
            error.message +
            "\n\nПроверьте, что запущен start.bat. Готовые тексты лежат в папке results."
        );
    } finally {
        startButton.disabled = false;
        syncStructureButton();
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

    try {
        const response = await fetch(`${API_URL}/export`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text,
                format,
                title: selectedFile ? selectedFile.name.replace(/\.[^.]+$/, "") : "Транскрипт",
            }),
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

startButton.addEventListener("click", startTranscription);
structureButton.addEventListener("click", structureText);
result.addEventListener("input", syncStructureButton);

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
checkServer();

const savedJobId = localStorage.getItem(ACTIVE_JOB_KEY);
if (savedJobId) {
    startButton.disabled = true;
    showBackgroundHint(true);
    setProgress(10, "Продолжаем фоновую обработку...");
    pollJob(savedJobId)
        .catch((error) => {
            setProgress(0, "0%");
            alert(error.message);
        })
        .finally(() => {
            startButton.disabled = false;
            syncStructureButton();
        });
}
