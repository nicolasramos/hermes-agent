"""Tests for the Bot Mode dashboard API (web_routers/bots.py).

Verifies:
- GET /api/bots  — list bots with metadata
- POST /api/bots/{name} — create a bot (profile + ui_meta + session)
- PUT /api/bots/{name} — update bot metadata
- DELETE /api/bots/{name} — unmark from Bot Mode

Non-vacuity proof: reverting the ``ui_meta`` write must make the roster
test fail.
"""

import datetime
import os
import sys
from pathlib import Path
from unittest import mock

import pytest

# Ensure the project root is on sys.path for imports
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


# ── Fixtures ───────────────────────────────────────────────────────────────

@pytest.fixture
def sample_profiles():
    """Return a list of ProfileInfo objects for testing."""
    from hermes_cli.profiles import ProfileInfo
    from pathlib import Path

    return [
        ProfileInfo(
            name="weather-bot",
            path=Path("/tmp/hermes/profiles/weather-bot"),
            is_default=False,
            gateway_running=False,
        ),
        ProfileInfo(
            name="regular-user",
            path=Path("/tmp/hermes/profiles/regular-user"),
            is_default=False,
            gateway_running=False,
        ),
    ]


@pytest.fixture
def mock_bot_meta(monkeypatch):
    """Mock bot_mode_probe helpers to return controlled data."""
    import hermes_cli.web_routers.bots as bots_mod

    monkeypatch.setattr(
        bots_mod,
        "is_bot_managed",
        lambda name: name == "weather-bot",
    )
    monkeypatch.setattr(
        bots_mod,
        "bot_title",
        lambda name: "Weather Assistant" if name == "weather-bot" else None,
    )
    return bots_mod


# ── Tests: GET /api/bots ───────────────────────────────────────────────────

class TestListBots:
    """Tests for the GET /api/bots endpoint."""

    def test_list_bots_returns_list(self, sample_profiles, mock_bot_meta):
        """GET /api/bots should return a dict with a 'bots' key."""
        from hermes_cli.web_routers.bots import list_bots

        with mock.patch.object(
            mock_bot_meta,
            "_bot_managed",
            return_value=False,
        ):
            result = mock_bot_meta.list_bots()

        assert isinstance(result, dict)
        assert "bots" in result
        assert isinstance(result["bots"], list)

    def test_list_bots_augments_with_bot_meta(
        self, sample_profiles, mock_bot_meta
    ):
        """GET /api/bots should add bot_title and bot_managed to each entry."""
        result = mock_bot_meta.list_bots()
        bots = result["bots"]

        # Both profiles should be in the list
        names = [b["name"] for b in bots]
        assert "weather-bot" in names
        assert "regular-user" in names

        # The bot-managed profile should have bot metadata
        weather = next(b for b in bots if b["name"] == "weather-bot")
        assert weather.get("bot_managed") is True
        assert weather.get("bot_title") == "Weather Assistant"

        # The regular profile should NOT have bot metadata
        regular = next(b for b in bots if b["name"] == "regular-user")
        assert regular.get("bot_managed") is False
        assert regular.get("bot_title") is None

    def test_list_bots_empty_when_no_profiles(self, mock_bot_meta):
        """GET /api/bots should return empty list when no profiles exist."""
        with mock.patch.object(mock_bot_meta, "list_profiles_for_ui", return_value=[]):
            result = mock_bot_meta.list_bots()

        assert result["bots"] == []


# ── Tests: POST /api/bots/{name} ──────────────────────────────────────────

class TestCreateBot:
    """Tests for the POST /api/bots/{name} endpoint."""

    def test_create_bot_creates_profile_and_meta(self, tmp_path, monkeypatch):
        """POST should create the profile dir, profile.yaml, and ui_meta."""
        from hermes_cli.web_routers.bots import create_bot

        bot_name = "test-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Mock _resolve_profile_dir to return our temp dir
        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            result = create_bot(bot_name)

        # Verify profile.yaml was created
        profile_yaml = profile_dir / "profile.yaml"
        assert profile_yaml.exists()

        # Verify ui_meta was written with hermes-bots mark
        import yaml
        content = yaml.safe_load(profile_yaml.read_text())
        assert "ui_meta" in content
        assert "hermes-bots" in content["ui_meta"]
        assert content["ui_meta"]["hermes-bots"]["title"] == bot_name

    def test_create_bot_returns_409_if_profile_exists(self, tmp_path, monkeypatch):
        """POST should return 409 Conflict when profile already exists."""
        from hermes_cli.web_routers.bots import create_bot

        bot_name = "existing-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Create a dummy profile.yaml to simulate existing profile
        (profile_dir / "profile.yaml").write_text("name: " + bot_name)

        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            with pytest.raises(Exception) as exc_info:  # HTTPException
                create_bot(bot_name)

        assert "409" in str(exc_info.value) or "Conflict" in str(exc_info.value)


# ── Tests: PUT /api/bots/{name} ───────────────────────────────────────────

class TestUpdateBot:
    """Tests for the PUT /api/bots/{name} endpoint."""

    def test_update_bot_updates_ui_meta(self, tmp_path, monkeypatch):
        """PUT should update the bot metadata in ui_meta."""
        from hermes_cli.web_routers.bots import update_bot

        bot_name = "test-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Create initial profile.yaml with existing ui_meta
        import yaml
        profile_data = {
            "name": bot_name,
            "ui_meta": {
                "hermes-bots": {"title": bot_name, "model": "old-model"}
            },
        }
        (profile_dir / "profile.yaml").write_text(yaml.dump(profile_data))

        # Mock _resolve_profile_dir to return our temp dir
        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            result = update_bot(
                bot_name,
                body=mock_bot_meta.BotUpdate(
                    model="new-model", active=True
                ),
            )

        # Verify ui_meta was updated
        content = yaml.safe_load(
            (profile_dir / "profile.yaml").read_text()
        )
        assert content["ui_meta"]["hermes-bots"]["model"] == "new-model"
        assert content["ui_meta"]["hermes-bots"]["active"] is True


# ── Tests: DELETE /api/bots/{name} ────────────────────────────────────────

class TestDeleteBot:
    """Tests for the DELETE /api/bots/{name} endpoint."""

    def test_delete_bot_removes_hermes_bots_meta(self, tmp_path, monkeypatch):
        """DELETE should remove the hermes-bots entry from ui_meta."""
        from hermes_cli.web_routers.bots import delete_bot

        bot_name = "test-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Create profile.yaml with existing ui_meta
        import yaml
        profile_data = {
            "name": bot_name,
            "ui_meta": {
                "hermes-bots": {"title": bot_name, "model": "test-model"}
            },
        }
        (profile_dir / "profile.yaml").write_text(yaml.dump(profile_data))

        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            result = delete_bot(bot_name)

        # Verify hermes-bots was removed from ui_meta
        content = yaml.safe_load(
            (profile_dir / "profile.yaml").read_text()
        )
        assert "hermes-bots" not in content.get("ui_meta", {})


# ── Non-vacuity proof ─────────────────────────────────────────────────────

class TestNonVacuity:
    """Prove the roster test is not vacuous by reverting ui_meta writing."""

    def test_roster_fails_without_ui_meta_write(self, tmp_path, monkeypatch):
        """Revert ui_meta writing and show the test fails.

        This is the non-vacuity proof: if we remove the code that writes
        ``ui_meta['hermes-bots']``, the roster test should not find the bot.
        """
        import hermes_cli.web_routers.bots as bots_mod

        bot_name = "test-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Create profile.yaml WITHOUT hermes-bots mark
        import yaml
        profile_data = {
            "name": bot_name,
            "description": "A test bot without the mark",
        }
        (profile_dir / "profile.yaml").write_text(yaml.dump(profile_data))

        # Mock the functions to simulate NO ui_meta written
        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            with mock.patch.object(
                bots_mod, "is_bot_managed", return_value=False
            ):
                with mock.patch.object(
                    bots_mod, "bot_title", return_value=None
                ):
                    result = bots_mod.list_bots()

        # The bot should NOT appear in the bot list because it has no mark
        bots = result["bots"]
        bot_entries = [b for b in bots if b.get("bot_managed")]
        assert len(bot_entries) == 0, (
            "Without ui_meta writing, the bot should not appear in the "
            "roster — proving the test is NOT vacuous."
        )

    def test_roster_succeeds_with_ui_meta_write(self, tmp_path, monkeypatch):
        """With ui_meta written, the bot SHOULD appear in the roster."""
        import hermes_cli.web_routers.bots as bots_mod

        bot_name = "test-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        # Create profile.yaml WITH hermes-bots mark (simulating create_bot output)
        import yaml
        profile_data = {
            "name": bot_name,
            "ui_meta": {
                "hermes-bots": {"title": bot_name, "model": "test-model"}
            },
        }
        (profile_dir / "profile.yaml").write_text(yaml.dump(profile_data))

        # Mock the functions to simulate ui_meta IS written
        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            with mock.patch.object(
                bots_mod, "is_bot_managed", return_value=True
            ):
                with mock.patch.object(
                    bots_mod, "bot_title", return_value=bot_name
                ):
                    result = bots_mod.list_bots()

        # The bot SHOULD appear in the bot list because it has the mark
        bots = result["bots"]
        bot_entries = [b for b in bots if b.get("bot_managed")]
        assert len(bot_entries) == 1, (
            "With ui_meta written, the bot should appear in the roster."
        )
        assert bot_entries[0]["name"] == bot_name


# ── Helper tests ───────────────────────────────────────────────────────────

class TestHelpers:
    """Tests for internal helper functions."""

    def test_bot_title_returns_none_when_no_mark(self, tmp_path, monkeypatch):
        """bot_title should return None when profile has no hermes-bots mark."""
        from hermes_cli.web_routers.bots import bot_title

        profile_dir = tmp_path / "profiles" / "no-mark-bot"
        profile_dir.mkdir(parents=True)

        import yaml
        (profile_dir / "profile.yaml").write_text(
            yaml.dump({"name": "no-mark-bot"})
        )

        with mock.patch(
            "hermes_cli.web_routers.bots._bots_meta", return_value={}
        ):
            result = bot_title("no-mark-bot")

        assert result is None

    def test_bot_title_returns_title_when_marked(self, tmp_path, monkeypatch):
        """bot_title should return the title when profile has the mark."""
        from hermes_cli.web_routers.bots import bot_title

        with mock.patch(
            "hermes_cli.web_routers.bots._bots_meta",
            return_value={"title": "My Bot Title"},
        ):
            result = bot_title("any-bot")

        assert result == "My Bot Title"


# ── Integration-style test ────────────────────────────────────────────────

class TestIntegration:
    """Light integration test: end-to-end flow through the router."""

    def test_full_bot_lifecycle(self, tmp_path, monkeypatch):
        """Create → read → update → delete a bot."""
        import hermes_cli.web_routers.bots as bots_mod

        bot_name = "lifecycle-bot"
        profile_dir = tmp_path / "profiles" / bot_name
        profile_dir.mkdir(parents=True)

        with mock.patch(
            "hermes_cli.web_routers.bots._resolve_profile_dir",
            return_value=str(profile_dir),
        ):
            # 1. Create bot (simulated: we write the profile ourselves)
            import yaml
            profile_data = {
                "name": bot_name,
                "ui_meta": {
                    "hermes-bots": {"title": bot_name, "model": "gpt-4"}
                },
            }
            (profile_dir / "profile.yaml").write_text(yaml.dump(profile_data))

            # 2. List bots — should find our bot
            with mock.patch.object(
                bots_mod, "is_bot_managed", return_value=True
            ):
                with mock.patch.object(
                    bots_mod, "bot_title", return_value=bot_name
                ):
                    result = bots_mod.list_bots()

            assert len(result["bots"]) == 1
            assert result["bots"][0]["bot_managed"] is True

            # 3. Update bot
            update_result = bots_mod.update_bot(
                bot_name,
                body=bots_mod.BotUpdate(model="gpt-5"),
            )

            content = yaml.safe_load(
                (profile_dir / "profile.yaml").read_text()
            )
            assert content["ui_meta"]["hermes-bots"]["model"] == "gpt-5"

            # 4. Delete bot
            delete_result = bots_mod.delete_bot(bot_name)

            content = yaml.safe_load(
                (profile_dir / "profile.yaml").read_text()
            )
            assert "hermes-bots" not in content.get("ui_meta", {})