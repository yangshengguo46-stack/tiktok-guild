from __future__ import annotations

import asyncio

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy.ext.asyncio import create_async_engine

from deerflow.persistence.bootstrap import _MIGRATIONS_DIR


@pytest.mark.asyncio
async def test_android_migration_preserves_old_accounts_but_retires_them(tmp_path):
    url = f"sqlite+aiosqlite:///{tmp_path / 'android-migration.db'}"
    cfg = Config()
    cfg.set_main_option("script_location", str(_MIGRATIONS_DIR))
    cfg.set_main_option("sqlalchemy.url", url)
    engine = create_async_engine(url)
    insert_sender = sa.text("INSERT INTO sender_account (owner_user_id,sender_account_id,channel,status,capabilities_json,created_at,updated_at) VALUES ('owner',:sender_id,:channel,'enabled','{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
    try:
        await asyncio.to_thread(command.upgrade, cfg, "0031_outreach_action_leases")
        async with engine.begin() as conn:
            await conn.execute(insert_sender, {"sender_id": "old-web", "channel": "web"})
        await asyncio.to_thread(command.upgrade, cfg, "0032_android_outreach_sender")
        async with engine.begin() as conn:
            assert (await conn.scalar(sa.text("SELECT status FROM sender_account WHERE sender_account_id='old-web'"))) == "retired"
            await conn.execute(insert_sender, {"sender_id": "android-1", "channel": "android"})
            assert (await conn.scalar(sa.text("SELECT COUNT(*) FROM sender_account"))) == 2
    finally:
        await engine.dispose()
