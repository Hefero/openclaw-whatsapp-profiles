#!/usr/bin/env python3
"""Small local TTS adapter for codex-proxy.

This intentionally vendors only the runtime pieces this repo needs instead of
depending on the sibling AITalker project layout.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import wave
from pathlib import Path


def synthesize_edge(args: argparse.Namespace) -> None:
    try:
        import edge_tts
    except ImportError as exc:
        raise RuntimeError("edge-tts is not installed. Run: python -m pip install edge-tts") from exc

    async def save() -> None:
        communicate = edge_tts.Communicate(
            args.text,
            args.voice or "pt-BR-FranciscaNeural",
            rate=args.rate or "+0%",
            pitch=args.pitch or "+0Hz",
            volume=args.volume or "+0%",
        )
        await communicate.save(str(args.output))

    asyncio.run(save())


def voice_search_paths(voices_dir: str | None) -> list[Path]:
    paths: list[Path] = []
    if voices_dir:
        paths.append(Path(voices_dir).expanduser().resolve())

    import os

    for env_name in ("LOCAL_TTS_VOICES_DIR", "AITALKER_VOICES_DIR"):
        value = os.environ.get(env_name)
        if value:
            paths.append(Path(value).expanduser().resolve())

    script_root = Path(__file__).resolve().parents[1]
    paths.extend([(Path.cwd() / "voices").resolve(), (script_root / "voices").resolve()])

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in paths:
        if path not in seen:
            unique.append(path)
            seen.add(path)
    return unique


def resolve_piper_voice(voice: str | None, voices_dir: str | None) -> Path:
    selected = voice or "pt_BR-jeff-medium"
    candidate = Path(selected)
    if candidate.suffix == ".onnx" and candidate.exists():
        return candidate.resolve()

    for root in voice_search_paths(voices_dir):
        model = root / f"{selected}.onnx"
        if model.exists():
            return model

    searched = ", ".join(str(path) for path in voice_search_paths(voices_dir))
    raise RuntimeError(f"Piper voice {selected!r} not found. Searched: {searched}")


def synthesize_piper(args: argparse.Namespace) -> None:
    try:
        from piper import PiperVoice
        from piper.config import SynthesisConfig
    except ImportError as exc:
        raise RuntimeError("piper-tts is not installed. Run: python -m pip install piper-tts") from exc

    model_path = resolve_piper_voice(args.voice, args.voices_dir)
    voice = PiperVoice.load(model_path)
    config = SynthesisConfig(length_scale=args.length_scale) if args.length_scale else None
    with wave.open(str(args.output), "wb") as wav_file:
        voice.synthesize_wav(args.text, wav_file, syn_config=config)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="local-tts")
    subcommands = parser.add_subparsers(dest="command", required=True)

    tts = subcommands.add_parser("tts")
    source = tts.add_mutually_exclusive_group(required=True)
    source.add_argument("--text")
    source.add_argument("--text-file")
    tts.add_argument("--output", required=True, type=Path)
    tts.add_argument("--engine", choices=["edge", "piper"], required=True)
    tts.add_argument("--voice")
    tts.add_argument("--rate")
    tts.add_argument("--pitch")
    tts.add_argument("--volume")
    tts.add_argument("--length-scale", type=float)
    tts.add_argument("--voices-dir")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command != "tts":
        parser.error("only the tts command is supported")

    args.text = args.text if args.text is not None else Path(args.text_file).read_text(encoding="utf-8")
    args.output.parent.mkdir(parents=True, exist_ok=True)

    try:
        if args.engine == "edge":
            synthesize_edge(args)
        else:
            synthesize_piper(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(str(args.output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
