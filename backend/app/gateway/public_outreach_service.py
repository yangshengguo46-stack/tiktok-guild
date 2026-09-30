"""Native public outreach composition and bounded Node execution transport."""

from __future__ import annotations

import asyncio
import json
import os
import signal
from pathlib import Path
from typing import Any
from uuid import uuid4

from deerflow.creator_agent.public_outreach import PublicOutreachWorkflow
from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository


class NodeExecutorTransport:
    """One Gateway-owned process; MCP processes never own provider execution."""

    def __init__(self, *, worker_path: Path, config_path: Path | None, runtime_root: Path, node: str = "node", timeout_seconds: float = 120, shutdown_seconds: float = 2):
        if not 0 < timeout_seconds <= 120 or not 0 < shutdown_seconds <= 5:
            raise ValueError("Execution and shutdown timeouts must fit within the native 300s lease")
        self.worker_path = worker_path
        self.config_path = config_path
        self.runtime_root = runtime_root
        self.node = node
        self.timeout_seconds = timeout_seconds
        self.shutdown_seconds = shutdown_seconds
        self.process: asyncio.subprocess.Process | None = None
        self.started = asyncio.Event()
        self._lock = asyncio.Lock()

    async def execute(self, **request: Any) -> dict[str, Any]:
        async with self._lock:
            if self.config_path is None:
                return {"verified": False, "error_code": "pilot_required"}
            if self.process is None:
                self.process = await asyncio.create_subprocess_exec(
                    self.node,
                    str(self.worker_path),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    start_new_session=True,
                    limit=256 * 1024,
                    env={**os.environ, "DEERFLOW_OUTREACH_EXECUTION_CONFIG": str(self.config_path), "DEERFLOW_OUTREACH_RUNTIME_ROOT": str(self.runtime_root)},
                )
            process = self.process
            self.started.set()
            request_id = uuid4().hex
            try:
                assert process.stdin is not None and process.stdout is not None
                # Cancellation is process-owned and never serialized as model data.
                request.pop("signal", None)
                process.stdin.write((json.dumps({"id": request_id, **request}) + "\n").encode())
                await process.stdin.drain()
                line = await asyncio.wait_for(process.stdout.readline(), self.timeout_seconds)
                if not line:
                    raise RuntimeError("Executor exited without a receipt")
                reply = json.loads(line)
                if reply.get("id") != request_id or not isinstance(reply.get("result"), dict):
                    raise ValueError("Invalid executor response")
                return reply["result"]
            except asyncio.CancelledError:
                await self.close()
                raise
            except TimeoutError:
                await self.close()
                return {"verified": False, "error_code": "timeout", "message": "Executor result is unknown; manual review is required."}
            except Exception:
                await self.close()
                return {"verified": False, "error_code": "operator_unavailable", "message": "Executor result is unknown; manual review is required."}

    async def close(self) -> None:
        process = self.process
        if process is None:
            return
        self.process = None
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), self.shutdown_seconds)
        except TimeoutError:
            pass
        finally:
            # A stalled Appium session may outlive Node; its resource fence remains until cleanup.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            await process.wait()


class PublicOutreachService:
    configured = True

    def __init__(self, repository: CreatorOutreachRepository, transport: NodeExecutorTransport, *, config: dict[str, Any]):
        self.repository = repository
        self.transport = transport
        self.config = config
        self.workflow = PublicOutreachWorkflow(repository, android_operator=transport.execute, lease_seconds=300)
        self._active: dict[str, asyncio.Task] = {}
        self._dispatch_lock = asyncio.Lock()

    async def list_accounts(self, *, owner_user_id: str) -> list[dict[str, Any]]:
        return await self.repository.list_sender_accounts(owner_user_id)

    async def device_operation(self, owner_user_id: str, device_ref: str, operation: str, *, commands: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if operation not in {"doctor", "control", "takeover", "resume"}:
            raise ValueError("Unsupported Android device operation")
        accounts = await self.repository.list_sender_accounts(owner_user_id, channel="android")
        bound = [row for row in accounts if row["device_ref"] == device_ref]
        if not bound:
            raise ValueError("Android device is not registered to this owner")
        sender = self.config.get("sender") or {}
        devices = self.config.get("devices")
        if not isinstance(devices, list):
            devices = [{**sender["device"], "device_ref": sender.get("device_ref")}] if sender.get("device") else []
        device = next((row for row in devices if row.get("device_ref") == device_ref), None)
        deployment_owner = (device or {}).get("owner_user_id")
        if deployment_owner is None and sender.get("device_ref") == device_ref:
            deployment_owner = sender.get("owner_user_id")
        if device is None or not deployment_owner or deployment_owner != owner_user_id:
            raise ValueError("Android device deployment owner does not match the authenticated owner")
        if operation == "control" and not any(row["status"] in {"enabled", "healthy", "ready", "active"} for row in bound):
            raise ValueError("Android device sender is paused")
        if operation == "takeover":
            for row in bound:
                await self.repository.set_sender_account_status(owner_user_id, row["sender_account_id"], status="paused", reason="manual_takeover")
                await self.cancel_account(owner_user_id, row["sender_account_id"])
        result = await self.transport.execute(operation=operation, device_ref=device_ref, owner_user_id=owner_user_id, **({"commands": commands} if commands is not None else {}))
        if operation == "control" and result.get("error_code") in {"write_unknown", "cleanup_unknown", "manual_takeover"}:
            for row in bound:
                await self.repository.set_sender_account_status(owner_user_id, row["sender_account_id"], status="paused", reason=result["error_code"])
        if operation == "resume" and result.get("ok") is True:
            health = await self.transport.execute(operation="doctor", device_ref=device_ref, owner_user_id=owner_user_id)
            if health.get("ok") is True:
                for row in bound:
                    await self.repository.set_sender_account_status(owner_user_id, row["sender_account_id"], status="enabled", reason="manual_takeover_resolved")
            else:
                return health
        return result

    async def capacity(self) -> dict[str, int]:
        def read() -> dict[str, int]:
            count = 0
            for path in (self.transport.runtime_root / "slots" / "android").glob("0.lock"):
                try:
                    lease = json.loads(path.read_text())
                    if not lease.get("cleanup_required"):
                        os.kill(int(lease["pid"]), 0)
                    count += 1
                except (FileNotFoundError, ProcessLookupError):
                    pass
                except (OSError, ValueError, KeyError):
                    count += 1  # An unreadable lock cannot establish that the Android worker is idle.
            return {"active": count, "active_limit": 1}

        return await asyncio.to_thread(read)

    def admitted(self, task: dict[str, Any]) -> bool:
        pilot = self.config.get("pilot", {})
        return (
            pilot.get("enabled") is True
            and pilot.get("owner_user_id") == task["owner_user_id"]
            and pilot.get("sender_account_id") == task["sender_account_id"]
            and pilot.get("creator_uid") == task["creator_uid"]
            and task["action"] in pilot.get("actions", [])
            and (task["action"] != "message" or pilot.get("message_enabled") is True)
        )

    async def execute_task(self, owner_user_id: str, task_id: str) -> dict[str, Any]:
        task = await self.repository.read_action_task(task_id)
        if not task or task["owner_user_id"] != owner_user_id:
            raise ValueError("Public outreach task not found")
        if task["state"] == "leased":
            await self.repository.release_expired_action_leases()
            task = await self.repository.read_action_task(task_id)
        task = await self.repository.reconcile_verified_terminal(owner_user_id, task_id) or task
        if task["state"] == "completed":
            return await self.workflow._duplicate_result(task)
        if await self.repository.contact_prohibited(owner_user_id, task["sender_account_id"], task["creator_uid"]):
            raise ValueError("Native do_not_contact prohibits outbound public outreach")
        if task["state"] != "pending" or task.get("error_code") or (task.get("payload_json") or {}).get("manual_required"):
            raise ValueError("Task requires manual review or explicit recovery before execution")
        if not self.admitted(task):
            return {"status": "blocked", "error_code": "pilot_required", "task": task}
        order = ["like", "comment", "follow", "message"]
        rows = await self.repository.list_action_tasks(owner_user_id, task["creator_uid"], task["sequence_no"])
        earlier = order[: order.index(task["action"])]
        if any(not any(row["action"] == action and row["state"] == "completed" for row in rows) for action in earlier):
            raise ValueError("Native action order requires like, comment, follow, then message")
        if task_id in self._active:
            raise ValueError("Task is already executing")
        model = await self.repository.read_model(owner_user_id=owner_user_id, creator_uid=task["creator_uid"])
        creator = {"creator_uid": task["creator_uid"]}
        for handoff in (model or {}).get("handoff", []):
            source = handoff.get("payload") or {}
            if source.get("handle") or source.get("username"):
                creator["handle"] = source.get("handle") or source.get("username")
                break
        from urllib.parse import urlparse

        for handoff in (model or {}).get("handoff", []):
            profile_url = (handoff.get("payload") or {}).get("profile_url")
            if isinstance(profile_url, str):
                parsed = urlparse(profile_url)
                if parsed.scheme == "https" and parsed.hostname in {"www.tiktok.com", "tiktok.com"} and parsed.path.startswith("/@"):
                    creator["profile_url"] = profile_url
                    break
        # Only native stored text crosses to execution. Selectors, provider
        # receipt claims and pilot flags come exclusively from deployment config.
        sender = await self.repository.read_sender_account(owner_user_id, task["sender_account_id"])
        if sender is None:
            raise ValueError("Registered sender not found")
        if sender["channel"] != "android":
            raise ValueError("historical web and ios tasks cannot execute")

        async def callback(**kwargs):
            kwargs["account"] = {key: sender.get(key) for key in ("owner_user_id", "sender_account_id", "external_ref", "channel", "device_ref")}
            kwargs["payload"] = {key: (task.get("payload_json") or {}).get(key) for key in ("comment", "message", "video_url")}
            return await self.transport.execute(**kwargs)

        workflow = PublicOutreachWorkflow(self.repository, android_operator=callback, lease_seconds=300)

        async def run_native():
            # Waiting for a serialized transport never consumes a native lease.
            async with self._dispatch_lock:
                return await workflow.execute_task(task_id, creator=creator)

        execution = asyncio.create_task(run_native(), name=f"outreach:{task_id}")
        self._active[task_id] = execution
        try:
            result = await execution
            if result.get("manual_required"):
                await self.repository.set_sender_account_status(owner_user_id, task["sender_account_id"], status="paused", reason=result.get("error_code") or "provider_unknown")
            return result
        except asyncio.CancelledError:
            current = await self.repository.read_action_task(task_id)
            if current and current["state"] == "failed":
                await self.repository.set_sender_account_status(owner_user_id, task["sender_account_id"], status="paused", reason="cancelled")
            raise
        finally:
            self._active.pop(task_id, None)

    async def cancel_task(self, task_id: str) -> None:
        execution = self._active.get(task_id)
        if execution is not None:
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)

    async def cancel_account(self, owner: str, sender_account_id: str) -> None:
        for task_id in list(self._active):
            task = await self.repository.read_action_task(task_id)
            if task and task["owner_user_id"] == owner and task["sender_account_id"] == sender_account_id:
                await self.cancel_task(task_id)

    async def cancel_sequence(self, owner: str, creator_uid: str, sequence_no: int) -> None:
        for task in await self.repository.list_action_tasks(owner, creator_uid, sequence_no):
            await self.cancel_task(task["task_id"])

    async def close(self) -> None:
        for execution in self._active.values():
            execution.cancel()
        await asyncio.gather(*self._active.values(), return_exceptions=True)
        await self.transport.close()


def create_public_outreach_service(repository: CreatorOutreachRepository) -> PublicOutreachService:
    config_path = os.getenv("PUBLIC_OUTREACH_EXECUTION_CONFIG")
    config = json.loads(Path(config_path).read_text(encoding="utf-8")) if config_path else {}
    root = Path(os.getenv("PUBLIC_OUTREACH_RUNTIME_ROOT", str(Path.home() / ".codex" / "tiktok-live-public-outreach"))).resolve()
    worker = Path(__file__).resolve().parents[3] / "ops/guild-runtime/public-outreach-operator/src/execution-worker.mjs"
    return PublicOutreachService(repository, NodeExecutorTransport(worker_path=worker, config_path=Path(config_path).resolve() if config_path else None, runtime_root=root), config=config)


async def initialize_public_outreach(app) -> None:
    from app.gateway.internal_auth import create_internal_auth_headers
    from deerflow.mcp.outreach_auth import set_public_outreach_auth_provider
    from deerflow.persistence.engine import get_session_factory

    repository = getattr(app.state, "creator_outreach_repo", None)
    if repository is None:
        factory = get_session_factory()
        if factory is None:
            app.state.public_outreach_operator_configured = False
            return
        repository = CreatorOutreachRepository(factory)
        app.state.creator_outreach_repo = repository
    service = create_public_outreach_service(repository)
    app.state.public_outreach_operator = service
    app.state.public_outreach_operator_configured = True

    from app.gateway.config import get_gateway_config

    gateway_url = os.getenv("PUBLIC_OUTREACH_GATEWAY_URL", f"http://127.0.0.1:{get_gateway_config().port}")

    def credentials(owner: str) -> dict[str, str]:
        headers = create_internal_auth_headers(owner_user_id=owner)
        return {
            "DEERFLOW_OUTREACH_OWNER_USER_ID": owner,
            "DEERFLOW_OUTREACH_INTERNAL_TOKEN": headers["X-DeerFlow-Internal-Token"],
            "DEERFLOW_OUTREACH_GATEWAY_URL": gateway_url,
        }

    set_public_outreach_auth_provider(credentials)


async def close_public_outreach(app) -> None:
    from deerflow.mcp.outreach_auth import set_public_outreach_auth_provider

    set_public_outreach_auth_provider(None)
    service = getattr(app.state, "public_outreach_operator", None)
    app.state.public_outreach_operator_configured = False
    if service is not None:
        try:
            await asyncio.wait_for(service.close(), timeout=8)
        finally:
            # Provider termination still runs when native persistence cleanup
            # fails. This is independently bounded by the transport deadline.
            await service.transport.close()
