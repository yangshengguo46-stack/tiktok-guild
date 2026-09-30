"""Native scheduled-task adapter for consented social followups."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta

from sqlalchemy.exc import IntegrityError

from deerflow.persistence.scheduled_tasks import ScheduledTaskRepository
from deerflow.social.contracts import FollowUp, SocialScope, bounded_text


class SocialFollowupScheduler:
    def __init__(self, repository: ScheduledTaskRepository, *, default_delay_seconds: int = 60) -> None:
        self.repository = repository
        self.default_delay_seconds = default_delay_seconds

    @staticmethod
    def _key(scope: SocialScope, revision: int) -> str:
        return hashlib.sha256(f"{scope.owner_user_id}:{scope.account_id}:{scope.person_ref}:{scope.channel_thread_ref}:{scope.agent_instance_id}:{revision}".encode()).hexdigest()[:32]

    async def schedule(self, scope: SocialScope, *, thread_id: str, followup: FollowUp, expected_revision: int, cancel_event_id: str) -> str:
        if not isinstance(scope, SocialScope) or not isinstance(followup, FollowUp) or type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("invalid social followup inputs")
        bounded_text(thread_id, "thread_id", 128)
        bounded_text(cancel_event_id, "cancel_event_id", 128)
        metadata = {
            "social_scope": {
                "owner_user_id": scope.owner_user_id,
                "account_id": scope.account_id,
                "person_ref": scope.person_ref,
                "channel_thread_ref": scope.channel_thread_ref,
                "agent_instance_id": scope.agent_instance_id,
            },
            "expected_revision": expected_revision,
            "cancel_event_id": cancel_event_id,
        }
        for task in await self.repository.list_by_user(scope.owner_user_id):
            if task.get("schedule_spec", {}).get("social_followup") == metadata:
                return task["id"]
        task_id = "social-followup-" + self._key(scope, expected_revision)
        if followup.not_before:
            next_run = datetime.fromisoformat(followup.not_before.replace("Z", "+00:00"))
            if next_run.tzinfo is None:
                raise ValueError("followup not_before requires timezone")
            next_run = next_run.astimezone(UTC)
            if next_run <= datetime.now(UTC):
                raise ValueError("followup not_before must be in the future")
        else:
            next_run = datetime.now(UTC) + timedelta(seconds=self.default_delay_seconds)
        try:
            await self.repository.create(
                task_id=task_id,
                user_id=scope.owner_user_id,
                thread_id=thread_id,
                context_mode="reuse_thread",
                assistant_id="lead_agent",
                title="Social followup",
                prompt=f"Social followup for {scope.person_ref}: {followup.check[:512]}",
                schedule_type="once",
                schedule_spec={"social_followup": metadata},
                timezone="UTC",
                next_run_at=next_run,
            )
        except IntegrityError:
            existing = await self.repository.get_internal(task_id)
            if existing is None or existing.get("schedule_spec", {}).get("social_followup") != metadata:
                raise ValueError("conflicting social followup already exists")
        return task_id

    async def cancel_for_creator_event(self, scope: SocialScope, event_id: str) -> list[str]:
        cancelled: list[str] = []
        for task in await self.repository.list_by_user(scope.owner_user_id):
            metadata = task.get("schedule_spec", {}).get("social_followup", {})
            expected_scope = {"owner_user_id": scope.owner_user_id, "account_id": scope.account_id, "person_ref": scope.person_ref, "channel_thread_ref": scope.channel_thread_ref, "agent_instance_id": scope.agent_instance_id}
            if metadata.get("social_scope") != expected_scope or metadata.get("cancel_event_id") == event_id:
                continue
            status = await self.repository.get_active_run_status(task["id"])
            if status == "running":
                continue
            result = await self.repository.pause_with_queue_cancellation(task["id"], user_id=scope.owner_user_id, error=f"cancelled by creator event {event_id}", now=datetime.now(UTC))
            if result == "paused":
                cancelled.append(task["id"])
        return cancelled
