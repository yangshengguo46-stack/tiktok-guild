"""Channel-neutral coordinator for public creator outreach.

The Web Playwright and iPhone XCUITest packages own provider interaction.  This
module only selects the registered sender, executes an injected operator, and
persists provider-owned receipts in the native DeerFlow repository.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable, Iterable
from typing import Any

from deerflow.persistence.creator_agent_relationship import CreatorOutreachRepository

_PUBLIC_ACTIONS = ("like", "comment", "follow")
_ACTION_ORDER = (*_PUBLIC_ACTIONS, "message")
_ACTION_GROUP_KEY = "action_group"


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _actions(value: Iterable[str]) -> list[str]:
    if isinstance(value, (str, bytes)):
        raise ValueError("actions must be an ordered list")
    result = list(value)
    if not result:
        raise ValueError("actions must not be empty")
    if any(action not in _ACTION_ORDER for action in result):
        raise ValueError("unsupported outreach action")
    if len(set(result)) != len(result):
        raise ValueError("outreach actions must be unique")
    if result != sorted(result, key=_ACTION_ORDER.index):
        raise ValueError("outreach actions must run in like -> comment -> follow -> message order")
    if any(action in result for action in _PUBLIC_ACTIONS) and not all(action in result for action in _PUBLIC_ACTIONS):
        raise ValueError("like, comment, and follow are required as one public action set")
    return result


def _payload(receipt: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(receipt, dict):
        raise ValueError("receipt must be an object")
    value = receipt.get("receipt_payload", receipt)
    if not isinstance(value, dict):
        raise ValueError("receipt_payload must be an object")
    return value


def _receipt_id(receipt: dict[str, Any], payload: dict[str, Any]) -> str:
    return _text(
        receipt.get("receipt_id") or receipt.get("provider_ref") or payload.get("receipt_id") or payload.get("provider_ref"),
        "receipt_id",
    )


def _verification_source(receipt: dict[str, Any], *, verified: bool) -> str:
    source = receipt.get("verification_source")
    if isinstance(source, str) and source:
        return source if len(source) <= 64 else "provider_readback"
    if isinstance(source, list) and source and all(isinstance(item, str) and item for item in source):
        return "provider_readback"
    return "provider_readback" if verified else "operator_unknown"


def _sender_from(payload: dict[str, Any], receipt: dict[str, Any]) -> str | None:
    value = payload.get("sender_account_id") or receipt.get("sender_account_id")
    return value if isinstance(value, str) and value else None


def _creator_from(payload: dict[str, Any], receipt: dict[str, Any]) -> str | None:
    value = payload.get("creator_uid") or receipt.get("creator_uid")
    return value if isinstance(value, str) and value else None


def _action_items(payload: dict[str, Any]) -> list[dict[str, Any]]:
    values = payload.get("actions")
    if values is None:
        return [payload]
    if not isinstance(values, list) or not values or any(not isinstance(item, dict) for item in values):
        raise ValueError("receipt actions must be a non-empty list of objects")
    return values


def _action_group(task: dict[str, Any], payload: dict[str, Any]) -> str:
    expected = (task.get("payload_json") or {}).get(_ACTION_GROUP_KEY)
    observed = payload.get(_ACTION_GROUP_KEY) or payload.get("group_id") or payload.get("outreach_group_id")
    if observed is not None and observed != expected:
        raise ValueError("receipt action group does not match task")
    return observed or expected or f"{task['owner_user_id']}:{task['creator_uid']}:{task['sequence_no']}:public"


def _operator_callable(operator: Any) -> Callable[..., Any] | None:
    if operator is None:
        return None
    if callable(operator):
        return operator
    for name in ("execute_public_outreach", "execute_web_action", "executeWebAction", "execute_ios_action", "executeIosAction", "execute"):
        candidate = getattr(operator, name, None)
        if callable(candidate):
            return candidate
    return None


def _provider_receipt_shape(receipt: Any) -> bool:
    return isinstance(receipt, dict) and isinstance(receipt.get("provider_ref"), str) and bool(receipt.get("provider_ref")) and isinstance(receipt.get("receipt_payload"), dict)


def _error_code(result: Any, default: str = "unknown") -> str:
    value = result.get("error_code") if isinstance(result, dict) else None
    return value if isinstance(value, str) and value else default


def _diagnostic_message(result: Any) -> str:
    value = result.get("message") if isinstance(result, dict) else None
    return value if isinstance(value, str) else "Provider result is unknown."


class PublicOutreachWorkflow:
    """Coordinate either provider channel through one native sequence."""

    def __init__(
        self,
        repository: CreatorOutreachRepository,
        *,
        web_operator: Any = None,
        ios_operator: Any = None,
        worker_id: str = "public-outreach-workflow",
        lease_seconds: int = 300,
    ) -> None:
        self.repository = repository
        self.web_operator = web_operator
        self.ios_operator = ios_operator
        self.worker_id = _text(worker_id, "worker_id")
        if type(lease_seconds) is not int or lease_seconds <= 0:
            raise ValueError("lease_seconds must be a positive integer")
        self.lease_seconds = lease_seconds

    async def create_public_outreach_tasks(
        self,
        owner_user_id: str,
        creator_uid: str,
        sequence_no: int,
        sender_account_id: str,
        actions: Iterable[str],
    ) -> list[dict[str, Any]]:
        normalized = _actions(actions)
        group = f"outreach:{owner_user_id}:{creator_uid}:{sequence_no}:public"
        tasks: list[dict[str, Any]] = []
        for action in normalized:
            tasks.append(
                await self.repository.enqueue_action(
                    owner_user_id,
                    creator_uid,
                    sequence_no,
                    sender_account_id,
                    action,
                    f"{group}:{action}",
                    payload={
                        _ACTION_GROUP_KEY: group,
                        "action_index": _ACTION_ORDER.index(action),
                    },
                )
            )
        return tasks

    async def _sender_for_task(self, task: dict[str, Any]) -> dict[str, Any]:
        sender = await self.repository.read_sender_account(
            task["owner_user_id"],
            task["sender_account_id"],
        )
        if sender is None:
            raise ValueError("sender account is not registered")
        return sender

    async def _public_ready(self, task: dict[str, Any]) -> tuple[bool, dict[str, Any] | None]:
        model = await self.repository.read_model(
            owner_user_id=task["owner_user_id"],
            creator_uid=task["creator_uid"],
        )
        if model is None or model["claim"]["status"] != "public_touched":
            return False, model
        public_tasks = [
            row
            for row in await self.repository.list_action_tasks(
                task["owner_user_id"],
                task["creator_uid"],
                task["sequence_no"],
            )
            if row["action"] in _PUBLIC_ACTIONS
        ]
        expected_group = (task.get("payload_json") or {}).get(_ACTION_GROUP_KEY)
        ready = (
            {row["action"] for row in public_tasks} == set(_PUBLIC_ACTIONS)
            and all(row["state"] == "completed" for row in public_tasks)
            and all(row["sender_account_id"] == task["sender_account_id"] for row in public_tasks)
            and all((row.get("payload_json") or {}).get(_ACTION_GROUP_KEY) == expected_group for row in public_tasks)
        )
        return ready, model

    async def _record_unknown_result(
        self,
        task: dict[str, Any],
        result: Any,
        *,
        claim: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        error_code = _error_code(result)
        provider_ref = result.get("provider_ref") if isinstance(result, dict) else None
        if not isinstance(provider_ref, str) or not provider_ref:
            provider_ref = None
        receipt_id = f"unknown:{task['task_id'][:64]}:{task.get('attempt_count', 0)}:{error_code[:32]}"
        diagnostic = {
            "receipt_type": "provider_unknown",
            "action": task["action"],
            "sender_account_id": task["sender_account_id"],
            "creator_uid": task["creator_uid"],
            "error_code": error_code,
            "message": _diagnostic_message(result),
            "manual_required": True,
        }
        if provider_ref is not None:
            diagnostic["provider_ref"] = provider_ref
        kind = "dm_receipt" if task["action"] == "message" else "public_action_receipt"
        if claim is not None:
            terminal = await self.repository.settle_external_attempt_unknown(
                task["task_id"],
                lease_owner=claim["lease_owner"],
                lease_token=claim["lease_token"],
                error_code=error_code,
                receipt_id=receipt_id,
            )
            if terminal["state"] == "completed":
                return await self._duplicate_result(terminal)
        stored = None
        try:
            stored = await self.repository.record_receipt(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
                sequence_no=task["sequence_no"],
                receipt_id=receipt_id,
                kind=kind,
                provider_ref=None,
                verification_source="operator_unknown",
                payload=diagnostic,
                verified=False,
            )
        except Exception:
            # A provider may repeat the same identifier with malformed details.
            # Task failure and sender pause were committed before diagnostics.
            stored = None
        ready, model = await self._public_ready(task) if task["action"] == "message" else (False, None)
        return {
            "status": "unknown",
            "error_code": error_code,
            "manual_required": True,
            "advanced": False,
            "public_ready": ready if task["action"] == "message" else None,
            "receipt": stored,
            "task": await self.repository.read_action_task(task["task_id"]),
            "model": model,
        }

    async def _duplicate_result(self, task: dict[str, Any]) -> dict[str, Any]:
        task = await self.repository.reconcile_verified_terminal(task["owner_user_id"], task["task_id"]) or task
        return {
            "status": "duplicate",
            "advanced": False,
            "receipt": {"receipt_id": task.get("receipt_id")} if task.get("receipt_id") else None,
            "task": task,
            "model": await self.repository.read_model(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
            ),
        }

    async def _claim_for_result(self, task: dict[str, Any]) -> dict[str, Any] | None:
        if task["state"] == "completed":
            return None
        claim = await self.repository.claim_action(
            task["task_id"],
            lease_seconds=self.lease_seconds,
            lease_owner=self.worker_id,
        )
        if claim is None:
            refreshed = await self.repository.read_action_task(task["task_id"])
            if refreshed and refreshed["state"] == "completed":
                return None
            model = await self.repository.read_model(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
            )
            sequence = next(
                (row for row in (model or {}).get("sequences", []) if row["sequence_no"] == task["sequence_no"]),
                None,
            )
            if sequence and sequence["status"] == "closed":
                return {"__sequence_closed__": True}
            raise ValueError("action task is already leased or unavailable")
        return claim

    async def _complete_task(
        self,
        task: dict[str, Any],
        *,
        receipt_id: str,
        claim: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if task["state"] == "completed":
            return task
        claim = claim or await self._claim_for_result(task)
        if claim is None:
            current = await self.repository.read_action_task(task["task_id"])
            if current is None:
                raise ValueError("action task does not exist")
            return current
        return await self.repository.complete_action(
            task["task_id"],
            sender_account_id=task["sender_account_id"],
            idempotency_key=task["idempotency_key"],
            receipt_id=receipt_id,
            lease_owner=claim["lease_owner"],
            lease_token=claim["lease_token"],
        )

    async def _store_receipt(
        self,
        task: dict[str, Any],
        receipt: dict[str, Any],
        *,
        kind: str,
        verified: bool,
        payload: dict[str, Any],
        claim: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return await self.repository.record_receipt(
            owner_user_id=task["owner_user_id"],
            creator_uid=task["creator_uid"],
            sequence_no=task["sequence_no"],
            receipt_id=_receipt_id(receipt, payload),
            kind=kind,
            provider_ref=receipt.get("provider_ref"),
            verification_source=_verification_source(receipt, verified=verified),
            payload=payload,
            verified=verified,
            **({"action_task_id": task["task_id"], "lease_owner": claim["lease_owner"], "lease_token": claim["lease_token"]} if claim else {}),
        )

    @staticmethod
    def _validate_sender_and_creator(
        task: dict[str, Any],
        receipt: dict[str, Any],
        payload: dict[str, Any],
        items: list[dict[str, Any]],
        *,
        require_identity: bool,
    ) -> None:
        sender = _sender_from(payload, receipt)
        creator = _creator_from(payload, receipt)
        nested_senders = {item.get("sender_account_id") for item in items if item.get("sender_account_id")}
        nested_creators = {item.get("creator_uid") for item in items if item.get("creator_uid")}
        if sender is None and len(nested_senders) == 1:
            sender = next(iter(nested_senders))
        if creator is None and len(nested_creators) == 1:
            creator = next(iter(nested_creators))
        if require_identity and (sender is None or creator is None):
            raise ValueError("verified receipt must identify its sender and creator")
        if sender is not None and sender != task["sender_account_id"]:
            raise ValueError("receipt sender differs from the active sequence sender")
        if creator is not None and creator != task["creator_uid"]:
            raise ValueError("receipt creator differs from the task creator")
        for item in items:
            item_sender = item.get("sender_account_id")
            item_creator = item.get("creator_uid")
            if item_sender is not None and item_sender != task["sender_account_id"]:
                raise ValueError("receipt action sender differs from the active sequence sender")
            if item_creator is not None and item_creator != task["creator_uid"]:
                raise ValueError("receipt action creator differs from the task creator")

    @staticmethod
    def _validate_public_items(
        task: dict[str, Any],
        payload: dict[str, Any],
        items: list[dict[str, Any]],
        *,
        group: str,
        verified: bool,
    ) -> None:
        sender = _sender_from(payload, payload)
        for item in items:
            item_group = item.get(_ACTION_GROUP_KEY) or item.get("group_id") or item.get("outreach_group_id") or group
            item_sender = item.get("sender_account_id") or sender
            item_type = item.get("receipt_type") or payload.get("receipt_type")
            item_verified = item.get("verified", verified)
            if item_group != group:
                raise ValueError("receipt action group does not match task")
            if item_sender != task["sender_account_id"]:
                raise ValueError("receipt action sender differs from the active sequence sender")
            if item_type != "public_action_receipt":
                raise ValueError("receipt action type is not public_action_receipt")
            if item_verified is not True:
                raise ValueError("receipt action is not verified")

    async def record_public_action_result(
        self,
        task_id: str,
        receipt: dict[str, Any],
        *,
        _claim: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        task = await self.repository.read_action_task(task_id)
        if task is None:
            raise ValueError("action task does not exist")
        if task["action"] not in _PUBLIC_ACTIONS:
            raise ValueError("public action result requires a like, comment, or follow task")
        if not _provider_receipt_shape(receipt) or receipt.get("verified") is not True:
            return await self._record_unknown_result(task, receipt, claim=_claim)
        try:
            payload = _payload(receipt)
            items = _action_items(payload)
            if payload.get("receipt_type") != "public_action_receipt":
                raise ValueError("receipt type is not public_action_receipt")
            self._validate_sender_and_creator(task, receipt, payload, items, require_identity=True)
            group = _action_group(task, payload)
            self._validate_public_items(task, payload, items, group=group, verified=True)
            item_actions = [item.get("action") for item in items]
            if any(action not in _PUBLIC_ACTIONS for action in item_actions):
                raise ValueError("public receipt contains an unsupported action")
            if task["action"] not in item_actions:
                raise ValueError("receipt action does not match task")
        except ValueError:
            return await self._record_unknown_result(task, receipt, claim=_claim)
        verified = True
        stored_payload = {**payload, _ACTION_GROUP_KEY: group}
        try:
            stored = await self._store_receipt(
                task,
                receipt,
                kind="public_action_receipt",
                verified=verified,
                payload=stored_payload,
                claim=_claim,
            )
        except ValueError:
            if len(items) <= 1:
                raise
            aggregate_receipt = {
                **receipt,
                "receipt_id": f"aggregate:{_receipt_id(receipt, payload)}",
            }
            stored = await self._store_receipt(
                task,
                aggregate_receipt,
                kind="public_action_receipt",
                verified=verified,
                payload=stored_payload,
                claim=_claim,
            )
        completed: list[dict[str, Any]] = []
        if verified:
            action_tasks = await self.repository.list_action_tasks(
                task["owner_user_id"],
                task["creator_uid"],
                task["sequence_no"],
            )
            action_set = set(item_actions)
            for current in action_tasks:
                if current["action"] in action_set:
                    completed.append(
                        await self._complete_task(
                            current,
                            receipt_id=stored["receipt_id"],
                            claim=_claim if current["task_id"] == task_id else None,
                        )
                    )
        elif _claim is not None:
            await self.repository.release_action_claim(
                task_id,
                lease_owner=_claim["lease_owner"],
                lease_token=_claim["lease_token"],
            )
        model = await self.repository.read_model(
            owner_user_id=task["owner_user_id"],
            creator_uid=task["creator_uid"],
        )
        advanced = verified and model is not None and task["action"] == "follow" and model["claim"]["status"] == "public_touched"
        if verified and model is not None and model["claim"]["status"] == "gray":
            public_tasks = [
                row
                for row in await self.repository.list_action_tasks(
                    task["owner_user_id"],
                    task["creator_uid"],
                    task["sequence_no"],
                )
                if row["action"] in _PUBLIC_ACTIONS
            ]
            if {row["action"] for row in public_tasks} == set(_PUBLIC_ACTIONS) and all(row["state"] == "completed" for row in public_tasks) and all((row.get("payload_json") or {}).get(_ACTION_GROUP_KEY) == group for row in public_tasks):
                await self.repository.advance_state(
                    owner_user_id=task["owner_user_id"],
                    creator_uid=task["creator_uid"],
                    sequence_no=task["sequence_no"],
                    receipt_id=stored["receipt_id"],
                    next_status="public_touched",
                )
                advanced = True
                model = await self.repository.read_model(
                    owner_user_id=task["owner_user_id"],
                    creator_uid=task["creator_uid"],
                )
        return {
            "status": "verified" if verified else "unknown",
            "advanced": advanced,
            "action_group": group,
            "receipt": stored,
            "task": await self.repository.read_action_task(task_id),
            "completed_tasks": completed,
            "model": model,
        }

    async def record_message_result(
        self,
        task_id: str,
        receipt: dict[str, Any],
        *,
        _claim: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        task = await self.repository.read_action_task(task_id)
        if task is None:
            raise ValueError("action task does not exist")
        if task["action"] != "message":
            raise ValueError("message result requires a message task")
        if task["state"] == "completed":
            return await self._duplicate_result(task)
        public_ready, model = await self._public_ready(task)
        if not public_ready:
            return {
                "status": "blocked",
                "error_code": "public_actions_required",
                "manual_required": False,
                "task": task,
                "model": model,
            }
        if not _provider_receipt_shape(receipt) or receipt.get("verified") is not True:
            return await self._record_unknown_result(task, receipt, claim=_claim)
        try:
            payload = _payload(receipt)
            items = _action_items(payload)
            self._validate_sender_and_creator(task, receipt, payload, items, require_identity=True)
            if payload.get("receipt_type") != "dm_receipt":
                raise ValueError("receipt type is not dm_receipt")
            if any(item.get("action") not in (None, "message") for item in items):
                raise ValueError("message receipt contains an unsupported action")
            group = _action_group(task, payload)
        except ValueError:
            return await self._record_unknown_result(task, receipt, claim=_claim)
        verified = True
        stored = await self._store_receipt(
            task,
            receipt,
            kind="dm_receipt",
            verified=verified,
            payload={**payload, _ACTION_GROUP_KEY: group},
            claim=_claim,
        )
        completed = []
        public_ready, model = await self._public_ready(task)
        if not public_ready:
            if _claim is not None:
                await self.repository.release_action_claim(
                    task_id,
                    lease_owner=_claim["lease_owner"],
                    lease_token=_claim["lease_token"],
                )
            return {
                "status": "blocked",
                "error_code": "public_actions_required",
                "manual_required": False,
                "task": await self.repository.read_action_task(task_id),
                "model": model,
            }
        if verified:
            completed.append(await self._complete_task(task, receipt_id=stored["receipt_id"], claim=_claim))
            model = await self.repository.read_model(owner_user_id=task["owner_user_id"], creator_uid=task["creator_uid"])
        elif _claim is not None:
            await self.repository.release_action_claim(
                task_id,
                lease_owner=_claim["lease_owner"],
                lease_token=_claim["lease_token"],
            )
        advanced = verified and model is not None and model["claim"]["status"] == "contacted"
        if verified and model is not None and model["claim"]["status"] == "public_touched":
            await self.repository.advance_state(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
                sequence_no=task["sequence_no"],
                receipt_id=stored["receipt_id"],
                next_status="contacted",
            )
            advanced = True
            model = await self.repository.read_model(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
            )
        return {
            "status": "verified" if verified else "unknown",
            "advanced": advanced,
            "action_group": group,
            "receipt": stored,
            "task": await self.repository.read_action_task(task_id),
            "completed_tasks": completed,
            "model": model,
        }

    async def record_inbound_result(self, task_id: str, receipt: dict[str, Any]) -> dict[str, Any]:
        task = await self.repository.read_action_task(task_id)
        if task is None:
            raise ValueError("action task does not exist")
        payload = _payload(receipt)
        items = _action_items(payload)
        self._validate_sender_and_creator(
            task,
            receipt,
            payload,
            items,
            require_identity=receipt.get("verified") is True,
        )
        receipt_type = payload.get("receipt_type")
        verified = receipt.get("verified") is True and receipt_type == "verified_inbound"
        stored = await self._store_receipt(
            task,
            receipt,
            kind="verified_inbound",
            verified=verified,
            payload=payload,
        )
        model = await self.repository.read_model(
            owner_user_id=task["owner_user_id"],
            creator_uid=task["creator_uid"],
        )
        advanced = False
        if verified and model is not None and model["claim"]["status"] in {"gray", "public_touched", "contacted"}:
            await self.repository.advance_state(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
                sequence_no=task["sequence_no"],
                receipt_id=stored["receipt_id"],
                next_status="replied",
            )
            advanced = True
            model = await self.repository.read_model(
                owner_user_id=task["owner_user_id"],
                creator_uid=task["creator_uid"],
            )
        return {
            "status": "verified" if verified else "unknown",
            "advanced": advanced,
            "receipt": stored,
            "model": model,
        }

    async def execute_task(
        self,
        task_id: str,
        *,
        creator: dict[str, Any],
        account: dict[str, Any] | None = None,
        device: dict[str, Any] | None = None,
        payload: dict[str, Any] | None = None,
        signal: Any = None,
    ) -> dict[str, Any]:
        task = await self.repository.read_action_task(task_id)
        if task is None:
            raise ValueError("action task does not exist")
        if task["state"] == "completed":
            return await self._duplicate_result(task)
        sender = await self._sender_for_task(task)
        if task["action"] == "message":
            public_ready, model = await self._public_ready(task)
            if not public_ready:
                return {
                    "status": "blocked",
                    "error_code": "public_actions_required",
                    "manual_required": False,
                    "task": task,
                    "model": model,
                }
        claim = await self._claim_for_result(task)
        if claim is None:
            current = await self.repository.read_action_task(task_id)
            return await self._duplicate_result(current or task)
        if claim.get("__sequence_closed__"):
            current = await self.repository.read_action_task(task_id)
            return {
                "status": "sequence_closed",
                "error_code": "sequence_closed",
                "task": current,
            }
        operator = self.web_operator if sender["channel"] == "web" else self.ios_operator
        callback = _operator_callable(operator)
        if callback is None:
            return await self._record_unknown_result(
                task,
                {"verified": False, "error_code": "operator_unavailable"},
                claim=claim,
            )
        execution_account = {
            **sender,
            **(account or {}),
            "sender_account_id": task["sender_account_id"],
            "channel": sender["channel"],
        }
        kwargs = {
            "account": execution_account,
            "creator": creator,
            "action": task["action"],
            "payload": {**(task.get("payload_json") or {}), **(payload or {})},
            "signal": signal,
        }
        if sender["channel"] == "ios":
            kwargs["device"] = device or {}
        finalizing = False
        try:
            task = await self.repository.mark_external_attempt_started(task_id, lease_owner=claim["lease_owner"], lease_token=claim["lease_token"])
            result = callback(**kwargs)
            if inspect.isawaitable(result):
                result = await result
            finalizing = True
            if not isinstance(result, dict):
                result = {"verified": False, "error_code": "unknown", "message": "Operator result must be an object."}
            if result.get("verified") is not True or not _provider_receipt_shape(result):
                return await self._record_unknown_result(task, result, claim=claim)
            if task["action"] == "message":
                return await self.record_message_result(task_id, result, _claim=claim)
            return await self.record_public_action_result(task_id, result, _claim=claim)
        except asyncio.CancelledError:
            terminal = await asyncio.shield(self._record_unknown_result(task, {"verified": False, "error_code": "cancelled"}, claim=claim))
            if terminal["status"] == "duplicate":
                return terminal
            raise
        except Exception as error:
            return await self._record_unknown_result(
                task,
                {
                    "verified": False,
                    "error_code": getattr(error, "error_code", "receipt_persistence_failed" if finalizing else "unknown"),
                    "message": str(error) or "Provider result is unknown.",
                },
                claim=claim,
            )


PublicOutreachCoordinator = PublicOutreachWorkflow


async def create_public_outreach_tasks(
    repository: CreatorOutreachRepository,
    owner_user_id: str,
    creator_uid: str,
    sequence_no: int,
    sender_account_id: str,
    actions: Iterable[str],
) -> list[dict[str, Any]]:
    return await PublicOutreachWorkflow(repository).create_public_outreach_tasks(
        owner_user_id,
        creator_uid,
        sequence_no,
        sender_account_id,
        actions,
    )


async def record_public_action_result(
    repository: CreatorOutreachRepository,
    task_id: str,
    receipt: dict[str, Any],
) -> dict[str, Any]:
    return await PublicOutreachWorkflow(repository).record_public_action_result(task_id, receipt)


async def record_message_result(
    repository: CreatorOutreachRepository,
    task_id: str,
    receipt: dict[str, Any],
) -> dict[str, Any]:
    return await PublicOutreachWorkflow(repository).record_message_result(task_id, receipt)


__all__ = [
    "PublicOutreachCoordinator",
    "PublicOutreachWorkflow",
    "create_public_outreach_tasks",
    "record_message_result",
    "record_public_action_result",
]
