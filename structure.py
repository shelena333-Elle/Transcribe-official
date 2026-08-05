"""Структурирование транскрипта: спикеры, абзацы, тематические блоки."""

from __future__ import annotations

import re
from collections import Counter
from typing import Any

STOPWORDS_RU = {
    "и", "в", "во", "не", "что", "он", "на", "я", "с", "со", "как", "а", "то",
    "все", "она", "так", "его", "но", "да", "ты", "к", "у", "же", "вы", "за",
    "бы", "по", "только", "ее", "мне", "было", "вот", "от", "меня", "еще",
    "нет", "о", "из", "ему", "теперь", "когда", "даже", "ну", "вдруг", "ли",
    "если", "уже", "или", "ни", "быть", "был", "него", "до", "вас", "нибудь",
    "опять", "уж", "вам", "ведь", "там", "потом", "себя", "ничего", "ей",
    "может", "они", "тут", "где", "есть", "надо", "ней", "для", "мы", "тебя",
    "их", "чем", "была", "сам", "чтоб", "без", "будто", "чего", "раз", "тоже",
    "себе", "под", "будет", "ж", "тогда", "кто", "этот", "того", "потому",
    "этого", "какой", "совсем", "ним", "здесь", "этом", "один", "почти",
    "мой", "тем", "чтобы", "нее", "сейчас", "были", "куда", "зачем", "всех",
    "никогда", "можно", "при", "наконец", "два", "об", "другой", "хоть",
    "после", "над", "больше", "тот", "через", "эти", "нас", "про", "всего",
    "них", "какая", "много", "разве", "три", "эту", "моя", "впрочем", "хорошо",
    "свою", "этой", "перед", "иногда", "лучше", "чуть", "том", "нельзя",
    "такой", "им", "более", "всегда", "конечно", "всю", "между", "это", "также",
    "просто", "очень", "ещё", "типа", "вот", "типа", "короче", "значит",
}

SENTENCE_SPLIT = re.compile(r"(?<=[.!?…])\s+|\n+")
WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9\-']{3,}", re.UNICODE)


def _normalize_speakers(names: list[str] | None, count: int) -> list[str]:
    cleaned = [str(n).strip() for n in (names or []) if str(n).strip()]
    if not cleaned:
        cleaned = [f"Спикер {i}" for i in range(1, max(count, 2) + 1)]
    while len(cleaned) < max(count, 2):
        cleaned.append(f"Спикер {len(cleaned) + 1}")
    return cleaned[: max(count, len(cleaned))]


def text_to_segments(text: str) -> list[dict[str, Any]]:
    """Грубое разбиение сплошного текста на псевдо-сегменты."""
    text = (text or "").strip()
    if not text:
        return []

    parts = [p.strip() for p in SENTENCE_SPLIT.split(text) if p.strip()]
    if not parts:
        return [{"start": 0.0, "end": 1.0, "text": text}]

    segments = []
    cursor = 0.0
    for part in parts:
        # ~12 символов ≈ 1 секунда речи — только для относительных пауз
        duration = max(1.2, len(part) / 12.0)
        segments.append({
            "start": cursor,
            "end": cursor + duration,
            "text": part,
            "from_text": True,
        })
        # Искусственная пауза между предложениями → отдельные реплики
        cursor += duration + 1.8
    return segments


def normalize_segments(raw_segments: list[dict] | None, fallback_text: str = "") -> list[dict[str, Any]]:
    if raw_segments:
        out = []
        for item in raw_segments:
            text = str(item.get("text", "")).strip()
            if not text:
                continue
            try:
                start = float(item.get("start", 0.0))
                end = float(item.get("end", start + 1.0))
            except (TypeError, ValueError):
                start, end = 0.0, 1.0
            if end < start:
                end = start + 1.0
            out.append({"start": start, "end": end, "text": text})
        if out:
            return out
    return text_to_segments(fallback_text)


def group_into_turns(
    segments: list[dict[str, Any]],
    pause_threshold: float = 1.4,
    max_turn_chars: int = 420,
) -> list[dict[str, Any]]:
    """Склеивает соседние сегменты в реплики по паузам и длине."""
    if not segments:
        return []

    # Для текста без таймкодов Whisper каждое предложение — отдельная реплика
    if all(seg.get("from_text") for seg in segments):
        return [{
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"],
        } for seg in segments]

    turns: list[dict[str, Any]] = []
    current = {
        "start": segments[0]["start"],
        "end": segments[0]["end"],
        "texts": [segments[0]["text"]],
    }

    for prev, seg in zip(segments, segments[1:]):
        gap = seg["start"] - prev["end"]
        joined_len = sum(len(t) for t in current["texts"]) + len(seg["text"])
        soft_break = seg["text"][:1].isupper() and prev["text"].rstrip().endswith((".", "!", "?", "…"))

        should_split = (
            gap >= pause_threshold
            or joined_len >= max_turn_chars
            or (gap >= 0.7 and soft_break and joined_len >= 80)
        )

        if should_split:
            turns.append({
                "start": current["start"],
                "end": current["end"],
                "text": " ".join(current["texts"]).strip(),
            })
            current = {
                "start": seg["start"],
                "end": seg["end"],
                "texts": [seg["text"]],
            }
        else:
            current["end"] = seg["end"]
            current["texts"].append(seg["text"])

    turns.append({
        "start": current["start"],
        "end": current["end"],
        "text": " ".join(current["texts"]).strip(),
    })
    return [t for t in turns if t["text"]]


def assign_speakers(
    turns: list[dict[str, Any]],
    speaker_names: list[str],
    change_pause: float = 1.6,
) -> list[dict[str, Any]]:
    """
    Назначает спикеров по смене реплик.
    Долгая пауза / начало нового предложения → вероятная смена говорящего.
    Для интервью (2 спикера) это даёт хороший базовый результат.
    """
    if not turns:
        return []

    names = _normalize_speakers(speaker_names, max(2, len(speaker_names or [])))
    result = []
    speaker_idx = 0

    for i, turn in enumerate(turns):
        if i > 0:
            gap = turn["start"] - turns[i - 1]["end"]
            prev_end = turns[i - 1]["text"].rstrip().endswith((".", "!", "?", "…"))
            # Смена спикера при заметной паузе или завершённой предыдущей фразе
            if gap >= change_pause or (gap >= 0.9 and prev_end):
                speaker_idx = (speaker_idx + 1) % len(names)

        result.append({
            **turn,
            "speaker": names[speaker_idx],
        })

    return result


def _keywords(text: str, limit: int = 4) -> list[str]:
    words = [w.lower() for w in WORD_RE.findall(text)]
    words = [w for w in words if w not in STOPWORDS_RU and not w.isdigit()]
    if not words:
        return []
    counts = Counter(words)
    return [w for w, _ in counts.most_common(limit)]


def _title_from_text(text: str, index: int) -> str:
    keywords = _keywords(text, limit=3)
    if keywords:
        pretty = ", ".join(k.capitalize() for k in keywords[:3])
        return f"Блок {index}: {pretty}"
    first = text.strip().split(".")[0].strip()
    if 12 <= len(first) <= 80:
        return f"Блок {index}: {first}"
    return f"Тематический блок {index}"


def split_thematic_blocks(
    turns: list[dict[str, Any]],
    target_minutes: float = 6.0,
    min_turns: int = 3,
) -> list[dict[str, Any]]:
    """Делит реплики на смысловые блоки по времени и формирует заголовки."""
    if not turns:
        return []

    window = max(120.0, target_minutes * 60.0)
    blocks: list[dict[str, Any]] = []
    bucket: list[dict[str, Any]] = []
    block_start = turns[0]["start"]

    for turn in turns:
        if not bucket:
            block_start = turn["start"]
            bucket = [turn]
            continue

        duration = turn["end"] - block_start
        if duration >= window and len(bucket) >= min_turns:
            text = " ".join(t["text"] for t in bucket)
            blocks.append({
                "title": _title_from_text(text, len(blocks) + 1),
                "start": bucket[0]["start"],
                "end": bucket[-1]["end"],
                "turns": bucket,
            })
            bucket = [turn]
            block_start = turn["start"]
        else:
            bucket.append(turn)

    if bucket:
        text = " ".join(t["text"] for t in bucket)
        blocks.append({
            "title": _title_from_text(text, len(blocks) + 1),
            "start": bucket[0]["start"],
            "end": bucket[-1]["end"],
            "turns": bucket,
        })

    # Если получился один короткий блок — всё равно даём заголовок
    if len(blocks) == 1 and len(turns) < min_turns:
        blocks[0]["title"] = "Основная часть"

    return blocks


def format_plain_text(blocks: list[dict[str, Any]], include_timestamps: bool = False) -> str:
    lines: list[str] = []
    for block in blocks:
        title = block.get("title") or "Блок"
        lines.append(title)
        lines.append("=" * min(48, max(12, len(title))))
        lines.append("")

        prev_speaker = None
        for turn in block.get("turns", []):
            speaker = turn.get("speaker") or "Спикер"
            text = (turn.get("text") or "").strip()
            if not text:
                continue

            if speaker != prev_speaker:
                if prev_speaker is not None:
                    lines.append("")
                stamp = ""
                if include_timestamps and turn.get("start") is not None:
                    stamp = f" [{_fmt_time(turn['start'])}]"
                lines.append(f"{speaker}{stamp}:")
                prev_speaker = speaker

            lines.append(text)

        lines.append("")
        lines.append("")

    return "\n".join(lines).strip() + ("\n" if lines else "")


def _fmt_time(seconds: float) -> str:
    total = max(0, int(seconds))
    m, s = divmod(total, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


def structure_transcript(
    *,
    text: str = "",
    segments: list[dict] | None = None,
    speaker_names: list[str] | None = None,
    speaker_count: int = 2,
    thematic: bool = True,
    pause_threshold: float = 1.4,
    change_pause: float = 1.6,
    topic_minutes: float = 6.0,
    include_timestamps: bool = False,
) -> dict[str, Any]:
    names = _normalize_speakers(speaker_names, speaker_count)
    segs = normalize_segments(segments, text)
    turns = group_into_turns(segs, pause_threshold=pause_threshold)
    labeled = assign_speakers(turns, names, change_pause=change_pause)

    if thematic:
        blocks = split_thematic_blocks(labeled, target_minutes=topic_minutes)
    else:
        blocks = [{
            "title": "Диалог",
            "start": labeled[0]["start"] if labeled else 0,
            "end": labeled[-1]["end"] if labeled else 0,
            "turns": labeled,
        }]

    plain = format_plain_text(blocks, include_timestamps=include_timestamps)

    return {
        "speakers": names,
        "blocks": blocks,
        "plain_text": plain,
        "turn_count": len(labeled),
        "block_count": len(blocks),
    }
