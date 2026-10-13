"""Bot Mode dashboard routes.

Endpoints for managing bots: a bot **is** a Hermes profile marked with
``ui_meta['hermes-bots']`` in its own ``profile.yaml`` (the canonical location).

Roster / creation / detail / update / unmark are implemented here. Routines are
NOT re-implemented: ``[bot:<name>]`` cron jobs are already served by the cron
router (``GET /api/cron/jobs`` and ``POST /api/cron/jobs/{id}/pause|resume|trigger``).

Routes
------
``GET    /api/bots``          roster: every profile, with its bot metadata
``POST   /api/bots``          create a bot (profile + ui_meta + canonical Bot Chat)
``GET    /api/bots/{name}``   one bot's metadata and its Bot Chat session id
``PUT    /api/bots/{name}``   edit title / description / model / provider
``DELETE /api/bots/{name}``   unmark from Bot Mode (keeps the profile)

Payloads (``hermes_cli.web_models``): ``BotCreate {name, title?, description?,
model?, provider?}`` and ``BotUpdate {title?, description?, model?, provider?}``.
"""

import datetime
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from hermes_cli.web_routers.profiles import _resolve_profile_dir
from hermes_cli.web_models import BotCreate, BotUpdate

_log = logging.getLogger("hermes_cli.web_server")
router = APIRouter()

# Exact title of the canonical per-bot chat session. Same literal the CLI uses
# (``hermes -p <bot> chat -c "Bot Chat" --create-if-missing``) and the one the
# desktop contract treats as the bot's identity session.
BOT_CHAT_TITLE = "Bot Chat"


# ---------------------------------------------------------------------------
# profile.yaml helpers — ui_meta['hermes-bots'] is read/written in profile.yaml
# ---------------------------------------------------------------------------


def _read_profile_yaml(profile_dir: Path) -> Optional[dict]:
    """Read ``profile.yaml`` at *profile_dir* and return the mapping, or None."""
    path = Path(profile_dir) / "profile.yaml"
    if not path.is_file():
        return None
    try:
        import yaml

        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _bots_meta(data: Optional[dict]) -> Optional[dict]:
    """The ``ui_meta['hermes-bots']`` block of a parsed profile.yaml, if a dict."""
    ui_meta = data.get("ui_meta") if data else None
    bots = ui_meta.get("hermes-bots") if isinstance(ui_meta, dict) else None
    return bots if isinstance(bots, dict) else None


def _is_bot_managed(profile_dir: Path) -> bool:
    return _bots_meta(_read_profile_yaml(profile_dir)) is not None


def _write_bots_meta(profile_dir: Path, block: Optional[dict]) -> None:
    """Write (or remove, when *block* is None) ``ui_meta['hermes-bots']`` in profile.yaml.

    Atomic write through the shared helper: a bare ``open("w")`` truncates before the
    dump and the read path swallows parse errors as ``{}``, so a crashed write would
    silently drop every other key of the file.
    """
    from utils import atomic_yaml_write

    path = Path(profile_dir) / "profile.yaml"
    data = _read_profile_yaml(profile_dir) or {}
    ui_meta = data.get("ui_meta")
    if not isinstance(ui_meta, dict):
        ui_meta = {}
        data["ui_meta"] = ui_meta
    if block is None:
        ui_meta.pop("hermes-bots", None)
        if not ui_meta:
            data.pop("ui_meta", None)
    else:
        ui_meta["hermes-bots"] = block
    atomic_yaml_write(path, data, sort_keys=False)


# ---------------------------------------------------------------------------
# Bot Chat session helpers — one canonical session per bot, in the bot's own DB
# ---------------------------------------------------------------------------


def _find_bot_chat_session(name: str) -> Optional[str]:
    """Return the id of the bot's canonical ``Bot Chat`` session, or None."""
    from hermes_cli.web_server_sessions import _open_session_db_for_profile

    try:
        db = _open_session_db_for_profile(name, read_only=True)
    except Exception as exc:  # missing/unreadable store: treat as "no session"
        _log.debug("No readable session store for %s: %s", name, exc)
        return None
    try:
        row = db.get_session_by_title(BOT_CHAT_TITLE)
        return row.get("id") if row else None
    except Exception as exc:
        _log.debug("Bot Chat lookup failed for %s: %s", name, exc)
        return None
    finally:
        try:
            db.close()
        except Exception:
            pass


def _create_bot_chat_session(name: str, profile_dir: Path) -> str:
    """Create the canonical ``Bot Chat`` session in the bot's own store; return its id.

    Uses the profile's ``state.db`` through the same opener the rest of the web
    server uses, so the row lands in the bot's store and not in the process's own.
    """
    from hermes_cli.web_server_sessions import _open_session_db_for_profile

    session_id = f"bot-chat-{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}-{uuid.uuid4().hex[:6]}"
    db = _open_session_db_for_profile(name, read_only=False)
    try:
        db.create_session(
            session_id,
            source="cli",
            profile_name=name,
            cwd=str(profile_dir),
        )
        db.set_session_title(session_id, BOT_CHAT_TITLE)
    finally:
        try:
            db.close()
        except Exception:
            pass
    return session_id


def _ensure_bot_chat_session(name: str, profile_dir: Path) -> Optional[str]:
    """Find the bot's Bot Chat session, creating it when missing (best effort)."""
    found = _find_bot_chat_session(name)
    if found:
        return found
    try:
        return _create_bot_chat_session(name, profile_dir)
    except Exception as exc:
        _log.warning("Could not create the Bot Chat session for %s: %s", name, exc)
        return None


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def _bot_payload(name: str, profile_dir: Path, *, with_session: bool = False) -> Dict[str, Any]:
    """One roster/detail entry: bot metadata plus the managed flag."""
    data = _read_profile_yaml(profile_dir) or {}
    meta = _bots_meta(data)
    entry: Dict[str, Any] = {
        "name": name,
        "bot_managed": meta is not None,
        "title": None,
        "description": str(data.get("description") or ""),
        "model": "",
        "provider": "",
    }
    if meta is not None:
        entry["title"] = str(meta.get("title") or "").strip() or name
        entry["description"] = str(meta.get("description") or entry["description"] or "")
        entry["model"] = str(meta.get("model") or "")
        entry["provider"] = str(meta.get("provider") or "")
    if with_session:
        entry["bot_chat_session_id"] = _ensure_bot_chat_session(name, profile_dir)
    return entry


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/bots")
async def list_bots():
    """Roster: every profile of the machine, with its Bot Mode metadata.

    Marked profiles also carry their canonical ``Bot Chat`` session id (created on
    the spot when missing — the equivalent of
    ``hermes -p <bot> chat -c "Bot Chat" --create-if-missing``).
    """
    def _run():
        from hermes_cli import profiles as profiles_mod

        bots: List[Dict[str, Any]] = []
        for profile in profiles_mod.list_profiles():
            entry = _bot_payload(profile.name, Path(profile.path), with_session=True)
            bots.append(entry)
        return {"bots": bots}

    return await run_in_threadpool(_run)


@router.post("/api/bots")
async def create_bot(body: BotCreate):
    """Create a bot: profile on disk + ``ui_meta.hermes-bots`` + canonical Bot Chat.

    All-or-nothing: any failure removes the profile directory it just created, so a
    rejected or failed POST never leaves a half-made bot behind.
    """
    def _run():
        from hermes_cli import profiles as profiles_mod

        try:
            canon = profiles_mod.normalize_profile_name(body.name)
            profiles_mod.validate_profile_name(canon)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))

        if canon == "default":
            raise HTTPException(status_code=400, detail="Cannot create a bot named 'default'")
        if profiles_mod.profile_exists(canon):
            raise HTTPException(status_code=409, detail=f"Profile '{canon}' already exists")

        try:
            profile_dir = Path(profiles_mod.create_profile(canon, no_alias=True))
        except (ValueError, FileExistsError) as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Could not create profile: {exc}")

        block: Dict[str, Any] = {
            "title": (body.title or "").strip() or canon,
            "description": body.description or "",
        }
        if body.model:
            block["model"] = body.model
        if body.provider:
            block["provider"] = body.provider

        try:
            _write_bots_meta(profile_dir, block)
            session_id = _create_bot_chat_session(canon, profile_dir)
        except Exception as exc:
            shutil.rmtree(profile_dir, ignore_errors=True)
            raise HTTPException(status_code=500, detail=f"Could not finish creating the bot: {exc}")

        return {
            "ok": True,
            "name": canon,
            "path": str(profile_dir),
            "title": block["title"],
            "bot_chat_session_id": session_id,
        }

    return await run_in_threadpool(_run)


@router.get("/api/bots/{name}")
async def get_bot_detail(name: str):
    """One bot: its metadata and its canonical Bot Chat session id."""
    def _run():
        profile_dir = _resolve_profile_dir(name)
        if not _is_bot_managed(profile_dir):
            raise HTTPException(status_code=404, detail=f"'{name}' is not a Bot Mode profile")
        return _bot_payload(name, profile_dir, with_session=False)

    return await run_in_threadpool(_run)


@router.put("/api/bots/{name}")
async def update_bot(name: str, body: BotUpdate):
    """Edit title / description / model / provider of an existing bot.

    SOUL.md, skills and MCPs are deliberately not handled here: they already have
    their own profile endpoints (``PUT /api/profiles/{name}/soul``, …).
    """
    def _run():
        profile_dir = _resolve_profile_dir(name)
        meta = _bots_meta(_read_profile_yaml(profile_dir))
        if meta is None:
            raise HTTPException(status_code=404, detail=f"'{name}' is not a Bot Mode profile")

        block = dict(meta)
        for key in ("title", "description", "model", "provider"):
            value = getattr(body, key)
            if value is not None:
                block[key] = value
        _write_bots_meta(profile_dir, block)
        return {"ok": True, "name": name, "bot": _bot_payload(name, profile_dir)}

    return await run_in_threadpool(_run)


@router.delete("/api/bots/{name}")
async def delete_bot(name: str):
    """Unmark a profile from Bot Mode. The profile itself (and its sessions) stay."""
    def _run():
        profile_dir = _resolve_profile_dir(name)
        if not _is_bot_managed(profile_dir):
            raise HTTPException(status_code=404, detail=f"'{name}' is not a Bot Mode profile")
        _write_bots_meta(profile_dir, None)
        return {"ok": True, "name": name}

    return await run_in_threadpool(_run)
