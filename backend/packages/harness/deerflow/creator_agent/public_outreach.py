"""Channel-neutral coordinator for public creator outreach.

The Web Playwright and iPhone XCUITest packages own provider interaction.  This
module only selects the registered sender, executes an injected operator, and
persists provider-owned receipts in the native DeerFlow repository.
"""

from __future__ import annotations

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
        return source
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
            if task.get("receipt_id") not in (None, receipt_id):
                raise ValueError("task receipt replay conflict")
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
        payload = _payload(receipt)
        items = _action_items(payload)
        self._validate_sender_and_creator(
            task,
            receipt,
            payload,
            items,
            require_identity=receipt.get("verified") is True,
        )
        group = _action_group(task, payload)
        item_actions = [item.get("action") for item in items]
        if any(action not in _PUBLIC_ACTIONS for action in item_actions):
            raise ValueError("public receipt contains an unsupported action")
        if task["action"] not in item_actions:
            raise ValueError("receipt action does not match task")
        verified = receipt.get("verified") is True and all(item.get("verified", True) is not False for item in items)
        stored = await self._store_receipt(
            task,
            receipt,
            kind="public_action_receipt",
            verified=verified,
            payload={**payload, _ACTION_GROUP_KEY: group},
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
        advanced = False
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
        payload = _payload(receipt)
        items = _action_items(payload)
        self._validate_sender_and_creator(
            task,
            receipt,
            payload,
            items,
            require_identity=receipt.get("verified") is True,
        )
        if any(item.get("action") not in (None, "message") for item in items):
            raise ValueError("message receipt contains an unsupported action")
        group = _action_group(task, payload)
        receipt_type = payload.get("receipt_type")
        verified = receipt.get("verified") is True and receipt_type == "dm_receipt" and all(item.get("verified", True) is not False for item in items)
        stored = await self._store_receipt(
            task,
            receipt,
            kind="dm_receipt",
            verified=verified,
            payload={**payload, _ACTION_GROUP_KEY: group},
        )
        completed = []
        if verified:
            completed.append(await self._complete_task(task, receipt_id=stored["receipt_id"], claim=_claim))
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
        advanced = False
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
        sender = await self._sender_for_task(task)
        claim = await self._claim_for_result(task)
        if claim is None:
            current = await self.repository.read_action_task(task_id)
            return {"status": "duplicate", "task": current}
        operator = self.web_operator if sender["channel"] == "web" else self.ios_operator
        callback = _operator_callable(operator)
        if callback is None:
            await self.repository.release_action_claim(
                task_id,
                lease_owner=claim["lease_owner"],
                lease_token=claim["lease_token"],
            )
            return {
                "status": "unknown",
                "error_code": "operator_unavailable",
                "task": await self.repository.read_action_task(task_id),
            }
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
        try:
            result = callback(**kwargs)
            if inspect.isawaitable(result):
                result = await result
        except Exception as error:
            await self.repository.release_action_claim(
                task_id,
                lease_owner=claim["lease_owner"],
                lease_token=claim["lease_token"],
            )
            return {
                "status": "unknown",
                "error_code": getattr(error, "error_code", "unknown"),
                "message": str(error) or "Provider result is unknown.",
                "task": await self.repository.read_action_task(task_id),
            }
        if not isinstance(result, dict):
            result = {"verified": False, "error_code": "unknown", "message": "Operator result must be an object."}
        try:
            if task["action"] == "message":
                return await self.record_message_result(task_id, result, _claim=claim)
            return await self.record_public_action_result(task_id, result, _claim=claim)
        except Exception:
            await self.repository.release_action_claim(
                task_id,
                lease_owner=claim["lease_owner"],
                lease_token=claim["lease_token"],
            )
            raise


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
