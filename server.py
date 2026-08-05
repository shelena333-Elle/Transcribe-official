import gc
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from flask_cors import CORS
from faster_whisper import WhisperModel

from export_docs import export_bytes
from structure import structure_transcript

BASE_DIR = Path(__file__).resolve().parent
RESULTS_DIR = BASE_DIR / "results"
JOBS_DIR = BASE_DIR / "jobs"
DEFAULT_MODEL = os.environ.get("WHISPER_MODEL", "base")
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "1200"))
PORT = int(os.environ.get("PORT", "5000"))

# Режим UI → размер модели Whisper (в памяти держим только одну)
MODE_MODELS = {
    "fast": "tiny",
    "accurate": "base",
}
ALLOWED_MODELS = set(MODE_MODELS.values()) | {"tiny", "base", "small"}

RESULTS_DIR.mkdir(exist_ok=True)
JOBS_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
CORS(app)

jobs = {}
jobs_lock = threading.Lock()
active_jobs = 0
active_jobs_lock = threading.Lock()

model = None
model_size_loaded = None
model_lock = threading.Lock()

print("Сервер готов. Модель Whisper загрузится при первой транскрибации.")
print(f"Режимы: быстрее=tiny, точнее=base. По умолчанию: {DEFAULT_MODEL}")
print(f"Нарезка: каждые {CHUNK_SECONDS // 60} мин. Результаты: {RESULTS_DIR}")


def resolve_model_size(mode: str | None, explicit: str | None = None) -> str:
    if explicit and explicit in ALLOWED_MODELS:
        return explicit
    if mode in MODE_MODELS:
        return MODE_MODELS[mode]
    if DEFAULT_MODEL in ALLOWED_MODELS:
        return DEFAULT_MODEL
    return "base"


def get_model(size: str) -> WhisperModel:
    """Ленивая загрузка: в RAM только одна модель, без лишней нагрузки."""
    global model, model_size_loaded
    size = size if size in ALLOWED_MODELS else "base"
    with model_lock:
        if model is not None and model_size_loaded == size:
            return model
        if model is not None:
            print(f"Выгружаем модель {model_size_loaded}, загружаем {size}...")
            del model
            model = None
            model_size_loaded = None
            gc.collect()
        print(f"Загрузка модели Whisper ({size})...")
        model = WhisperModel(size, device="cpu", compute_type="int8")
        model_size_loaded = size
        print(f"Модель {size} готова.")
        return model


if sys.platform == "win32":
    import ctypes

    ES_CONTINUOUS = 0x80000000
    ES_SYSTEM_REQUIRED = 0x00000001

    def prevent_sleep_begin():
        ctypes.windll.kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        )

    def prevent_sleep_end():
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS)
else:
    def prevent_sleep_begin():
        pass

    def prevent_sleep_end():
        pass


def set_job(job_id, **fields):
    with jobs_lock:
        jobs[job_id].update(fields)


def get_job(job_id):
    with jobs_lock:
        return dict(jobs.get(job_id, {}))


def begin_background_work():
    global active_jobs
    with active_jobs_lock:
        active_jobs += 1
        if active_jobs == 1:
            prevent_sleep_begin()


def end_background_work():
    global active_jobs
    with active_jobs_lock:
        active_jobs = max(0, active_jobs - 1)
        if active_jobs == 0:
            prevent_sleep_end()


def safe_result_name(original_filename, job_id, suffix=".txt"):
    stem = Path(original_filename).stem
    stem = re.sub(r"[^\w\s\-().]", "", stem, flags=re.UNICODE).strip()
    stem = re.sub(r"\s+", "_", stem) or "transcription"
    return f"{stem}_{job_id}{suffix}"


def run_ffmpeg(args):
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Неизвестная ошибка ffmpeg").strip()
        raise RuntimeError(detail)
    return result


def get_audio_duration(path):
    result = run_ffmpeg([
        "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        path,
    ])
    return float(result.stdout.strip())


def prepare_chunks(source_path, temp_dir):
    duration = get_audio_duration(source_path)

    if duration <= CHUNK_SECONDS:
        return [source_path], duration, 1

    chunks = []
    start = 0.0
    index = 0

    while start < duration:
        chunk_path = os.path.join(temp_dir, f"chunk_{index:04d}.wav")
        length = min(CHUNK_SECONDS, duration - start)

        run_ffmpeg([
            "ffmpeg", "-y",
            "-i", source_path,
            "-ss", str(start),
            "-t", str(length),
            "-ar", "16000",
            "-ac", "1",
            chunk_path,
        ])

        chunks.append(chunk_path)
        start += CHUNK_SECONDS
        index += 1

    return chunks, duration, len(chunks)


def transcribe_file(path, language, whisper_model, time_offset=0.0, beam_size=5):
    segments_iter, info = whisper_model.transcribe(
        path,
        language=language,
        beam_size=beam_size,
        vad_filter=True,
    )
    segments = []
    texts = []
    for segment in segments_iter:
        text = segment.text.strip()
        if not text:
            continue
        texts.append(text)
        segments.append({
            "start": round(segment.start + time_offset, 2),
            "end": round(segment.end + time_offset, 2),
            "text": text,
        })
    return " ".join(texts), segments, info.language


def process_job(job_id, source_path, language, original_filename, mode="accurate"):
    begin_background_work()
    temp_dir = tempfile.mkdtemp()
    model_name = resolve_model_size(mode)
    # tiny + меньший beam — быстрее на том же CPU
    beam_size = 1 if model_name == "tiny" else 5

    try:
        set_job(
            job_id,
            status="preparing",
            message=f"Подготовка файла (режим: {'быстрее' if mode == 'fast' else 'точнее'}, модель {model_name})...",
            mode=mode,
            model=model_name,
        )

        whisper = get_model(model_name)
        chunks, duration, total = prepare_chunks(source_path, temp_dir)
        minutes = int(duration // 60)

        set_job(
            job_id,
            status="processing",
            total=total,
            chunk=0,
            duration_minutes=minutes,
            message=(
                f"Файл ~{minutes} мин., модель {model_name}"
                + (f", {total} частями" if total > 1 else "")
            ),
        )

        parts = []
        all_segments = []
        detected_language = language

        for index, chunk_path in enumerate(chunks, start=1):
            set_job(
                job_id,
                chunk=index,
                message=f"Часть {index} из {total} ({model_name})...",
            )

            time_offset = (index - 1) * CHUNK_SECONDS
            text, segments, detected_language = transcribe_file(
                chunk_path,
                language,
                whisper,
                time_offset=time_offset,
                beam_size=beam_size,
            )
            if text:
                parts.append(text)
            all_segments.extend(segments)

        full_text = " ".join(parts)
        result_name = safe_result_name(original_filename, job_id)
        result_path = RESULTS_DIR / result_name
        result_path.write_text(full_text, encoding="utf-8")

        segments_name = safe_result_name(original_filename, job_id, suffix=".segments.json")
        (RESULTS_DIR / segments_name).write_text(
            json.dumps(all_segments, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        set_job(
            job_id,
            status="done",
            text=full_text,
            segments=all_segments,
            language=detected_language,
            result_file=result_name,
            segments_file=segments_name,
            mode=mode,
            model=model_name,
            message="Готово",
        )

        print(f"Готово: {result_name} ({len(all_segments)} сегментов, {model_name})")

    except Exception as exc:
        set_job(job_id, status="error", error=str(exc), message="Ошибка")
        print(f"Ошибка задачи {job_id}: {exc}")

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
        end_background_work()


@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "model": model_size_loaded or DEFAULT_MODEL,
        "modes": {
            "fast": MODE_MODELS["fast"],
            "accurate": MODE_MODELS["accurate"],
        },
        "chunk_minutes": CHUNK_SECONDS // 60,
        "results_dir": str(RESULTS_DIR),
        "features": ["structure", "export", "speed_mode"],
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "file" not in request.files:
        return jsonify({"error": "Файл не передан"}), 400

    uploaded = request.files["file"]
    if not uploaded.filename:
        return jsonify({"error": "Пустой файл"}), 400

    language = "ru"
    mode = (request.form.get("mode") or "accurate").strip().lower()
    if mode not in MODE_MODELS:
        mode = "accurate"
    model_name = resolve_model_size(mode)

    suffix = os.path.splitext(uploaded.filename)[1] or ".audio"
    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    source_path = job_dir / f"source{suffix}"
    uploaded.save(source_path)

    with jobs_lock:
        jobs[job_id] = {
            "status": "queued",
            "message": "Файл принят, начинаем...",
            "filename": uploaded.filename,
            "mode": mode,
            "model": model_name,
            "chunk": 0,
            "total": 0,
            "created": datetime.now().isoformat(timespec="seconds"),
        }

    thread = threading.Thread(
        target=process_job,
        args=(job_id, str(source_path), language, uploaded.filename, mode),
        daemon=True,
    )
    thread.start()

    return jsonify({
        "job_id": job_id,
        "filename": uploaded.filename,
        "mode": mode,
        "model": model_name,
        "message": "Обработка запущена в фоне",
    })


@app.route("/jobs/<job_id>")
def job_status(job_id):
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Задача не найдена"}), 404
    return jsonify(job)


@app.route("/structure", methods=["POST"])
def structure():
    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    segments = data.get("segments")
    speakers = data.get("speakers") or []
    speaker_count = int(data.get("speaker_count") or max(len(speakers), 2))
    thematic = bool(data.get("thematic", True))
    include_timestamps = bool(data.get("include_timestamps", False))
    topic_minutes = float(data.get("topic_minutes") or 6)

    if not text.strip() and not segments:
        return jsonify({"error": "Нет текста для структурирования"}), 400

    try:
        result = structure_transcript(
            text=text,
            segments=segments,
            speaker_names=speakers,
            speaker_count=speaker_count,
            thematic=thematic,
            topic_minutes=topic_minutes,
            include_timestamps=include_timestamps,
        )
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_name = f"structured_{stamp}.txt"
    (RESULTS_DIR / out_name).write_text(result["plain_text"], encoding="utf-8")
    result["result_file"] = out_name
    return jsonify(result)


@app.route("/export", methods=["POST"])
def export_file():
    data = request.get_json(silent=True) or {}
    text = data.get("text") or ""
    fmt = (data.get("format") or "txt").lower()
    title = data.get("title") or "Транскрипт"

    if not text.strip():
        return jsonify({"error": "Пустой текст"}), 400

    try:
        payload, mime, filename = export_bytes(text, fmt, title=title)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Ошибка экспорта: {exc}"}), 500

    return send_file(
        path_or_file=io.BytesIO(payload),
        mimetype=mime,
        as_attachment=True,
        download_name=filename,
    )


@app.route("/<path:filename>")
def static_files(filename):
    if filename.startswith("jobs/"):
        abort(404)
    return send_from_directory(BASE_DIR, filename)


if __name__ == "__main__":
    print(f"Откройте в браузере: http://127.0.0.1:{PORT}")
    app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
