#!/usr/bin/env python3
"""Regression tests for the note quiz module (diff engine + prompt overrides).

Does not call Ollama. Covers:
  - html -> numbered-line parsing
  - append-only diff with prefix-hash matching (incl. changed-prefix detection)
  - prompt override flow (note_quiz_user / note_quiz_generate) and fallbacks
  - AI JSON parsing + question validation / clamping
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import note_quiz
from prompts import get_prompt, list_prompts


SAMPLE = """
<h1>Photosynthesis</h1>
<p><strong>Chlorophyll:</strong> Green pigment that absorbs solar photons.</p>
<p><strong>Thylakoids:</strong> Disk-shaped sacs where light reactions occur.</p>
<p><strong>Stroma:</strong> Fluid space outside thylakoids where Calvin cycle runs.</p>
<p>RuBisCO is the enzyme that fixes carbon dioxide in the Calvin cycle.</p>
"""


def test_html_to_lines():
    lines = note_quiz.html_to_lines(SAMPLE)
    assert len(lines) == 5
    # Global line indices are 0-based internally (display is 1-based)
    assert lines[0] == (0, "Photosynthesis")
    assert "<strong>Chlorophyll:</strong>" in lines[1][1]
    assert lines[-1][0] == 4


def test_diff_first_snapshot():
    diff = note_quiz.diff_appended(SAMPLE, None, 0)
    assert diff["total_lines"] == 5
    assert len(diff["added_lines"]) == 5
    assert diff["snapshot_match"] is True
    # added lines are global (index, html) pairs
    assert diff["added_lines"][0][0] == 0


def test_diff_appended_unchanged_prefix():
    lines = note_quiz.html_to_lines(SAMPLE)
    plain = [note_quiz._line_visible_text(html) for _, html in lines]
    snap_hash = note_quiz._hash_lines(plain)

    more = SAMPLE + ("<p><strong>Photolysis:</strong> Splitting of water.</p>"
                     "<p>NADPH carries electrons to the Calvin cycle.</p>")
    diff = note_quiz.diff_appended(more, snap_hash, 5)
    assert diff["snapshot_match"] is True
    assert diff["total_lines"] == 7
    assert len(diff["added_lines"]) == 2
    assert diff["added_lines"][0][0] == 5


def test_diff_detects_changed_prefix():
    lines = note_quiz.html_to_lines(SAMPLE)
    snap_hash = note_quiz._hash_lines(["changed prefix"] * len(lines))
    diff = note_quiz.diff_appended(SAMPLE, snap_hash, len(lines))
    assert diff["snapshot_match"] is False


def test_prompt_overrides_flow():
    s_default = {}
    assert "Write quiz questions" in note_quiz._build_simple_prompt("BLOCK", s_default)
    assert "noteLineStart" in get_prompt(s_default, "note_quiz_generate")

    s_override = {
        "prompts": {
            "note_quiz_user": "CUSTOM TEMPLATE {notes_block} END",
            "note_quiz_generate": "CUSTOM SYSTEM",
        }
    }
    assert note_quiz._build_simple_prompt("BLOCK", s_override) == "CUSTOM TEMPLATE BLOCK END"
    assert get_prompt(s_override, "note_quiz_generate") == "CUSTOM SYSTEM"

    # Blank override falls back to the default
    s_blank = {"prompts": {"note_quiz_user": "   "}}
    assert note_quiz._build_simple_prompt("BLOCK", s_blank).startswith("Write quiz questions")


def test_list_prompts_default_state():
    lst = list_prompts({})
    keys = [p["key"] for p in lst]
    assert "note_quiz_generate" in keys
    assert "note_quiz_user" in keys
    assert "blooket_system" in keys
    assert all(p["current"] == p["default"] and p["isDefault"] for p in lst)


def test_parse_strict_json_fences():
    raw = '```json\n{"questions": []}\n```'
    assert note_quiz._parse_strict_json(raw) == {"questions": []}
    assert note_quiz._parse_strict_json('{"questions": []}') == {"questions": []}
    assert note_quiz._parse_strict_json("not json") is None


def _sample_notes():
    words = ["alpine", "basalt", "citron", "delta", "epsilon"]
    return [(i, f"<strong>Term{i}:</strong> Description of term {i}. {words[i - 1]} clue.") for i in range(1, 6)]


class _Patch:
    """Tiny monkeypatch context manager (no pytest dependency)."""

    def __init__(self, module, name, replacement):
        self.module = module
        self.name = name
        self.orig = getattr(module, name)
        self.replacement = replacement

    def __enter__(self):
        setattr(self.module, self.name, self.replacement)
        return self

    def __exit__(self, *exc):
        setattr(self.module, self.name, self.orig)
        return False


def _fake_ollama(payload):
    def fake_ollama_request(_payload, _key):
        return {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": "submit_questions", "arguments": note_quiz.json.dumps(payload)}}],
        }
    return _Patch(note_quiz, "_ollama_request_message", fake_ollama_request)


def test_generate_questions_validation():
    notes = _sample_notes()
    good = {
        "questions": [
            {
                "prompt": "Which term does this describe?",
                "choices": ["Term1", "Term2", "Term3", "Term4"],
                "correctIndex": 0,
                "explanation": "It is term one.",
                "noteLineStart": 1,
                "noteLineEnd": 1,
            },
            {
                "prompt": "Bad choices question",
                "choices": ["Only one"],
                "correctIndex": 0,
                "noteLineStart": 2,
                "noteLineEnd": 2,
            },
        ]
    }
    settings = {"apiKeys": {"ollama": "test-key"}, "ollamaModel": "test-model"}
    with _fake_ollama(good):
        result = note_quiz.generate_questions(notes, settings)
    out = result["questions"]
    assert len(out) == 1, "the malformed question should be dropped"
    q = out[0]
    assert q["correctIndex"] == 0
    assert q["noteLineStart"] == 0  # stored 0-based (frontend index space)
    assert q["noteLineEnd"] == 0


def test_generate_questions_title_extracted():
    notes = _sample_notes()
    payload = {
        "title": "14.2 Cell Structure",
        "questions": [
            {
                "prompt": "Which line has the citron clue?",
                "choices": ["A", "B", "C", "D"],
                "correctIndex": 2,
                "noteLineStart": 1,
                "noteLineEnd": 1,
            }
        ],
    }
    settings = {"apiKeys": {"ollama": "test-key"}, "ollamaModel": "test-model"}
    with _fake_ollama(payload):
        result = note_quiz.generate_questions(notes, settings)
    assert result["title"] == "14.2 Cell Structure"
    assert len(result["questions"]) == 1


def test_generate_questions_out_of_range_fallback():
    notes = _sample_notes()
    payload = {
        "questions": [
            {
                "prompt": "Which line has the citron clue?",
                "choices": ["A", "B", "C", "D"],
                "correctIndex": 2,
                "noteLineStart": 999,
                "noteLineEnd": 999,
            }
        ]
    }
    settings = {"apiKeys": {"ollama": "test-key"}, "ollamaModel": "test-model"}
    with _fake_ollama(payload):
        result = note_quiz.generate_questions(notes, settings)
    out = result["questions"]
    assert len(out) == 1
    # Out-of-range refs fall back to the line whose text matches the prompt.
    assert out[0]["noteLineStart"] == 2  # Term3 -> 0-based index 2
    assert out[0]["noteLineEnd"] == 2

def test_generate_questions_returns_all():
    notes = _sample_notes()
    many = {
        "questions": [
            {
                "prompt": f"Which fact is described in question {i}?",
                "choices": ["A", "B", "C", "D"],
                "correctIndex": 0,
                "noteLineStart": 1,
                "noteLineEnd": 1,
            }
            for i in range(60)
        ]
    }
    settings = {"apiKeys": {"ollama": "test-key"}, "ollamaModel": "test-model"}
    with _fake_ollama(many):
        result = note_quiz.generate_questions(notes, settings)
    assert len(result["questions"]) == 60


def test_generate_questions_missing_key():
    try:
        note_quiz.generate_questions(_sample_notes(), {"ollamaModel": "x"})
    except ValueError as exc:
        assert "API key" in str(exc)
    else:
        raise AssertionError("expected ValueError for missing API key")


def _run_all():
    import inspect
    tests = [(name, fn) for name, fn in globals().items() if name.startswith("test_") and callable(fn)]
    passed = 0
    failed = 0
    for name, fn in sorted(tests):
        try:
            fn()
            print(f"  PASS  {name}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {name}: {exc}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all())
