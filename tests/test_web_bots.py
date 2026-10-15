"""Real (non-mocked) tests for the Bot Mode dashboard API.

Covers the acceptance criteria of NRA-4435:
  1. the roster walks the profiles of the *test* HOME and reports a non-empty
     bot title for a marked profile;
  2. creating a bot leaves the three things — the profile on disk,
     ``ui_meta['hermes-bots']`` inside ``profile.yaml``, and a session whose title
     is exactly ``Bot Chat`` (read back from the profile's own session store);
  3. repeating the creation with the same name fails without side effects;
  4. the roster test is not vacuous (it fails when the ui_meta write is skipped);
  5. walking the roster leaves an unmarked profile's directory untouched (it must
     not create ``state.db`` nor its lock files, nor announce a Bot Chat).

``tests/conftest.py`` already points ``HERMES_HOME`` at a per-test tmpdir, so these
tests create real profiles and real session rows there.
"""

import asyncio
from pathlib import Path

import pytest
import yaml
from fastapi import HTTPException

import hermes_cli.web_routers.bots as bots
from hermes_cli import profiles as profiles_mod
from hermes_cli.web_models import BotCreate, BotUpdate

BOT_CHAT_TITLE = "Bot Chat"


# ── Helpers ────────────────────────────────────────────────────────────────


def _call(coro):
    """Run one async endpoint to completion."""
    return asyncio.run(coro)


def _make_profile(name: str) -> Path:
    """Create a real profile inside the test HOME."""
    return Path(profiles_mod.create_profile(name, no_alias=True, no_skills=True))


def _mark_bot(profile_dir: Path, title: str, **extra) -> None:
    """Write ``ui_meta['hermes-bots']`` the way a bot profile carries it."""
    data = bots._read_profile_yaml(profile_dir) or {}
    data.setdefault("ui_meta", {})["hermes-bots"] = {"title": title, **extra}
    (profile_dir / "profile.yaml").write_text(yaml.dump(data), encoding="utf-8")


def _bot_chat_rows(name: str):
    """Every session of *name*'s own store titled exactly ``Bot Chat``."""
    from hermes_cli.web_server_sessions import _open_session_db_for_profile

    db = _open_session_db_for_profile(name, read_only=True)
    try:
        rows = db.list_sessions_rich(include_hidden=True, include_children=True, limit=200)
    finally:
        db.close()
    return [row for row in rows if (row.get("title") or "") == BOT_CHAT_TITLE]


def _entry(roster: dict, name: str) -> dict:
    return next(b for b in roster["bots"] if b["name"] == name)


# ── 1. roster ──────────────────────────────────────────────────────────────


def test_roster_lists_every_profile_of_the_test_home():
    """The roster returns the real profiles of the test HOME, marked and unmarked."""
    marked_dir = _make_profile("weather-bot")
    _make_profile("regular-user")
    _mark_bot(marked_dir, "Weather Assistant", model="qwen3.6-35b")

    roster = _call(bots.list_bots())
    names = [b["name"] for b in roster["bots"]]
    assert "weather-bot" in names
    assert "regular-user" in names

    marked = _entry(roster, "weather-bot")
    assert marked["bot_managed"] is True
    assert marked["title"] == "Weather Assistant"  # non-empty bot title
    assert marked["model"] == "qwen3.6-35b"

    plain = _entry(roster, "regular-user")
    assert plain["bot_managed"] is False
    assert plain["title"] is None


def test_roster_gives_each_bot_its_canonical_bot_chat_session():
    """Walking the roster finds or creates the bot's ``Bot Chat`` session."""
    marked_dir = _make_profile("dm-bot")
    _mark_bot(marked_dir, "DM Bot")
    assert _bot_chat_rows("dm-bot") == []

    first = _entry(_call(bots.list_bots()), "dm-bot")
    session_id = first["bot_chat_session_id"]
    assert session_id, "the roster must hand out a Bot Chat session id"

    rows = _bot_chat_rows("dm-bot")
    assert [row["id"] for row in rows] == [session_id]
    assert rows[0]["title"] == BOT_CHAT_TITLE

    # A second walk reuses the same canonical session instead of making a new one.
    again = _entry(_call(bots.list_bots()), "dm-bot")
    assert again["bot_chat_session_id"] == session_id
    assert len(_bot_chat_rows("dm-bot")) == 1


# ── 2. creation ────────────────────────────────────────────────────────────


def test_create_bot_leaves_profile_ui_meta_and_bot_chat():
    """POST /api/bots creates the profile, the ui_meta mark and the Bot Chat."""
    result = _call(
        bots.create_bot(
            BotCreate(
                name="helper-bot",
                title="Helper",
                description="Answers questions",
                model="qwen3.6-35b",
            )
        )
    )
    assert result["ok"] is True

    profile_dir = Path(profiles_mod.get_profile_dir("helper-bot"))
    assert profile_dir.is_dir()

    data = yaml.safe_load((profile_dir / "profile.yaml").read_text(encoding="utf-8"))
    block = data["ui_meta"]["hermes-bots"]
    assert block["title"] == "Helper"
    assert block["description"] == "Answers questions"
    assert block["model"] == "qwen3.6-35b"

    rows = _bot_chat_rows("helper-bot")
    assert len(rows) == 1, "exactly one canonical Bot Chat session"
    assert rows[0]["title"] == BOT_CHAT_TITLE
    assert rows[0]["id"] == result["bot_chat_session_id"]


def test_create_bot_rejects_a_duplicate_without_side_effects():
    """A second POST with the same name fails and creates nothing new."""
    _call(bots.create_bot(BotCreate(name="dup-bot", title="Dup")))

    with pytest.raises(HTTPException) as excinfo:
        _call(bots.create_bot(BotCreate(name="dup-bot", title="Dup again")))
    assert excinfo.value.status_code == 409

    profile_dir = Path(profiles_mod.get_profile_dir("dup-bot"))
    data = yaml.safe_load((profile_dir / "profile.yaml").read_text(encoding="utf-8"))
    assert data["ui_meta"]["hermes-bots"]["title"] == "Dup"
    assert len(_bot_chat_rows("dup-bot")) == 1


# ── 3. detail / update / unmark ────────────────────────────────────────────


def test_detail_update_and_unmark_round_trip():
    _call(bots.create_bot(BotCreate(name="lifecycle-bot", title="First")))

    detail = _call(bots.get_bot_detail("lifecycle-bot"))
    assert detail["bot_managed"] is True
    assert detail["title"] == "First"

    updated = _call(bots.update_bot("lifecycle-bot", BotUpdate(title="Second", model="m2")))
    assert updated["ok"] is True
    assert updated["bot"]["title"] == "Second"
    assert updated["bot"]["model"] == "m2"

    _call(bots.delete_bot("lifecycle-bot"))
    assert _entry(_call(bots.list_bots()), "lifecycle-bot")["bot_managed"] is False
    with pytest.raises(HTTPException) as excinfo:
        _call(bots.get_bot_detail("lifecycle-bot"))
    assert excinfo.value.status_code == 404


# ── 4. non-vacuity ─────────────────────────────────────────────────────────


def test_roster_is_not_vacuous(monkeypatch):
    """Skip the ui_meta write and the roster must stop reporting the bot.

    This is the in-suite half of the non-vacuity proof: if ``create_bot`` did not
    write ``ui_meta['hermes-bots']``, ``bot_managed`` could not flip to True.
    """
    monkeypatch.setattr(bots, "_write_bots_meta", lambda profile_dir, block: None)

    _call(bots.create_bot(BotCreate(name="unwritten-bot", title="Never written")))

    entry = _entry(_call(bots.list_bots()), "unwritten-bot")
    assert entry["bot_managed"] is False, (
        "without the ui_meta write the profile must NOT be reported as a bot — "
        "otherwise the roster assertions above are vacuous"
    )


# ── 5. the roster is a read ────────────────────────────────────────────────


def _profile_dir_entries(name: str):
    """Every entry of the profile's own directory, sorted — dot files included."""
    return sorted(entry.name for entry in Path(profiles_mod.get_profile_dir(name)).iterdir())


def test_roster_never_writes_into_an_unmarked_profile():
    """Walking the roster must not open — let alone populate — a plain profile's store.

    Regression for the measured defect: the roster built the canonical Bot Chat of
    *every* profile, so simply listing the bots created ``state.db`` (with its
    ``*.lock`` files) and a ``Bot Chat`` session inside profiles that do not carry
    ``ui_meta['hermes-bots']``. The walk is a read; an unmarked profile's directory
    must be exactly what it was.

    The second half pins the guard's shape: it must skip only *unmarked* profiles,
    so the very same walk still hands the marked bot its Bot Chat session.
    """
    _make_profile("plain-user")
    _mark_bot(_make_profile("marked-bot"), "Marked Bot")

    before = _profile_dir_entries("plain-user")
    roster = _call(bots.list_bots())

    created = sorted(set(_profile_dir_entries("plain-user")) - set(before))
    assert not created, f"read-only roster walk wrote into an unmarked profile: {created}"

    plain = _entry(roster, "plain-user")
    assert plain["bot_managed"] is False
    assert "bot_chat_session_id" not in plain, (
        "an unmarked profile must not announce a Bot Chat session"
    )

    marked = _entry(roster, "marked-bot")
    assert marked["bot_chat_session_id"], (
        "the guard must skip unmarked profiles only — a marked bot still gets its "
        "canonical Bot Chat from the same walk"
    )
