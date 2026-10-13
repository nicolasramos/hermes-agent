"""Bot Mode dashboard routes.

Endpoints for managing bots (profiles marked with ``ui_meta['hermes-bots']``).

Routines live under ``[bot:<name>]`` and are served by the existing cron router.
"""

import datetime
import logging
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from hermes_cli.web_routers.profiles import _profile_to_dict, _resolve_profile_dir
from hermes_cli.web_models import BotCreate, BotUpdate

_log = logging.getLogger("hermes_cli.web_server")
router = APIRouter()


# ── Helpers ────────────────────────────────────────────────────────────────

def _bot_home_for_profile(name: str) -> str:
    """Return the HERMES_HOME that points to a specific bot profile."""
    from hermes_cli import profiles as profiles_mod
    home = profiles_mod.get_hermes_home()
    return str(Path(home) / "bots" / name)


def _create_bot_chat_session(profile_home: str, bot_name: str) -> Dict[str, Any]:
    """Create a 'Bot Chat' session in the bot's own database so conversations stay profile-isolated.
    """
    from hermes_cli import profiles as profiles_mod
    from hermes_state import SessionDB
    import os

    old_home = profiles_mod._HERMES_HOME.get()
    try:
        os.environ["HERMES_HOME"] = profile_home
        profiles_mod._HERMES_HOME.set(profile_home)

        db = SessionDB()
        session_id = f"bot-chat-{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}-{uuid.uuid4().hex[:6]}"
        db.create_session(
            profile=bot_name,
            title="Bot Chat",
            source="cli",
        )
        db.set_session_title(session_id, "Bot Chat")

        return {
            "session_id": session_id,
        }
    finally:
        if old_home is not None:
            os.environ["HERMES_HOME"] = old_home
            profiles_mod._HERMES_HOME.set(old_home)


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/api/bots")
async def list_bots():
    """List all bots (profiles with the hermes-bots mark)."""
    def _run():
        from hermes_cli import profiles as profiles_mod

        home = profiles_mod.get_hermes_home()
        profiles = profiles_mod.list_profiles(home)

        bots: List[Dict[str, Any]] = []
        for profile in profiles:
            if not profiles_mod._bot_managed(profile):
                continue

            profile_dir = _resolve_profile_dir(profile.name, home)
            if profile_dir is None:
                continue

            # Add bot metadata
            meta_path = Path(profile_dir) / "ui_meta.yaml"
            if meta_path.exists():
                import yaml
                existing = yaml.safe_load(meta_path.read_text()) or {}
                bots_meta = existing.get("hermes-bots", {})
            else:
                bots_meta = {}

            bots.append({
                "name": profile.name,
                "title": bots_meta.get("title", profile.name),
                "path": profile_dir,
            })

        return {"bots": bots}

    return await run_in_threadpool(_run)


@router.post("/api/bots")
async def create_bot(body: BotCreate):
    """Create a new bot profile and register it in Bot Mode.

    Raises 409 if the profile already exists.
    """
    def _run():
        from hermes_cli import profiles as profiles_mod

        home = profiles_mod.get_hermes_home()

        # Check if the profile already exists
        profile_dir = _resolve_profile_dir(body.name, home)
        if profile_dir is not None:
            raise HTTPException(409, f"Profile '{body.name}' already exists")

        # Create the profile first
        profile_dir = profiles_mod.create_profile(body.name)

        # Write hermes-bots UI metadata
        import yaml
        meta: Dict[str, Any] = {
            "hermes-bots": {
                "title": body.title or body.name,
                "description": body.description or "",
            }
        }
        if body.soul:
            meta["hermes-bots"]["soul"] = body.soul
        if body.provider:
            meta["hermes-bots"]["provider"] = body.provider

        meta_path = Path(profile_dir) / "ui_meta.yaml"
        meta_path.write_text(yaml.dump(meta, default_flow_style=False))

        # Create the 'Bot Chat' session in the bot's own DB
        bot_home = _bot_home_for_profile(body.name)
        session_result = _create_bot_chat_session(bot_home, body.name)

        return {
            "ok": True,
            "name": body.name,
            "session_id": session_result["session_id"],
        }

    return await run_in_threadpool(_run)


@router.get("/api/bots/{name}")
async def get_bot_detail(name: str):
    """Show a bot's metadata and sessions from its own database."""
    def _run():
        from hermes_cli import profiles as profiles_mod

        home = profiles_mod.get_hermes_home()
        profile_dir = _resolve_profile_dir(name, home)
        if profile_dir is None:
            raise HTTPException(404, f"Bot '{name}' not found")

        # Read bot metadata
        meta_path = Path(profile_dir) / "ui_meta.yaml"
        import yaml
        meta = yaml.safe_load(meta_path.read_text()) or {}
        bots_meta = meta.get("hermes-bots", {})

        # Read sessions from bot's own DB
        bot_home = _bot_home_for_profile(name)
        old_home = profiles_mod._HERMES_HOME.get()
        try:
            if old_home is not None:
                profiles_mod._HERMES_HOME.set(bot_home)

            db = SessionDB()
            sessions = db.list_sessions(profile=name)

            return {
                "name": name,
                "title": bots_meta.get("title", name),
                "sessions": sessions,
            }
        finally:
            if old_home is not None:
                profiles_mod._HERMES_HOME.set(old_home)

    return await run_in_threadpool(_run)


@router.put("/api/bots/{name}")
async def update_bot(name: str, body: BotUpdate):
    """Update bot metadata: title, description, soul, model, provider, active."""
    def _run():
        from hermes_cli import profiles as profiles_mod

        home = profiles_mod.get_hermes_home()
        profile_dir = _resolve_profile_dir(name, home)
        if profile_dir is None:
            raise HTTPException(404, f"Bot '{name}' not found")

        meta_path = Path(profile_dir) / "ui_meta.yaml"
        if not meta_path.exists():
            raise HTTPException(404, f"No hermes-bots mark for '{name}'")

        import yaml
        meta = yaml.safe_load(meta_path.read_text()) or {}
        bots_meta = meta.setdefault("hermes-bots", {})

        if body.title is not None:
            bots_meta["title"] = body.title
        if body.description is not None:
            bots_meta["description"] = body.description
        if body.soul is not None:
            bots_meta["soul"] = body.soul
        if body.model is not None:
            bots_meta["model"] = body.model
        if body.provider is not None:
            bots_meta["provider"] = body.provider
        if body.active is not None:
            bots_meta["active"] = body.active

        meta_path.write_text(yaml.dump(meta, default_flow_style=False))
        return {"ok": True, "name": name}

    return await run_in_threadpool(_run)


@router.delete("/api/bots/{name}")
async def delete_bot(name: str):
    """Remove the hermes-bots mark (unmark from Bot Mode)."""
    def _run():
        from hermes_cli import profiles as profiles_mod

        home = profiles_mod.get_hermes_home()
        profile_dir = _resolve_profile_dir(name, home)
        if profile_dir is None:
            raise HTTPException(404, f"Bot '{name}' not found")

        meta_path = Path(profile_dir) / "ui_meta.yaml"
        if not meta_path.exists():
            raise HTTPException(404, f"No hermes-bots mark for '{name}'")

        import yaml
        meta = yaml.safe_load(meta_path.read_text()) or {}
        if "hermes-bots" in meta:
            del meta["hermes-bots"]
            if meta:
                meta_path.write_text(yaml.dump(meta, default_flow_style=False))
            else:
                meta_path.unlink()

        return {"ok": True, "name": name}

    return await run_in_threadpool(_run)