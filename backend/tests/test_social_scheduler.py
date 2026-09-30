from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

from app.scheduler.social_followups import SocialFollowupScheduler
from deerflow.social.contracts import FollowUp, SocialScope

SCOPE = SocialScope("owner", "account", "creator", "thread")


class FakeRepository:
    def __init__(self):
        self.tasks = []
        self.active = {}

    async def list_by_user(self, user_id):
        return [task for task in self.tasks if task["user_id"] == user_id]

    async def create(self, **kwargs):
        self.tasks.append(kwargs | {"id": kwargs["task_id"]})

    async def get_internal(self, task_id):
        return next((task for task in self.tasks if task["id"] == task_id), None)

    async def get_active_run_status(self, task_id):
        return self.active.get(task_id)

    async def pause_with_queue_cancellation(self, task_id, **kwargs):
        return "executing" if self.active.get(task_id) in {"launching", "running"} else "paused"


class RaceRepository(FakeRepository):
    """Simulate a second writer winning the native task insert."""

    def __init__(self):
        super().__init__()
        self._first_create = True

    async def create(self, **kwargs):
        if self._first_create:
            self._first_create = False
            self.tasks.append(kwargs | {"id": kwargs["task_id"]})
            raise IntegrityError("duplicate", {}, None)
        await super().create(**kwargs)


@pytest.mark.asyncio
async def test_followup_replay_returns_same_native_task_id():
    scheduler = SocialFollowupScheduler(FakeRepository())
    followup = FollowUp("check in", "new message", (datetime.now(UTC) + timedelta(minutes=5)).isoformat())
    first = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=followup, expected_revision=4, cancel_event_id="event-4")
    second = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=followup, expected_revision=4, cancel_event_id="event-4")
    assert second == first


@pytest.mark.asyncio
async def test_followup_same_revision_recovers_even_when_cancel_event_differs():
    repo = FakeRepository()
    scheduler = SocialFollowupScheduler(repo)
    followup = FollowUp("check in", "new message")
    first = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=followup, expected_revision=4, cancel_event_id="event-4")
    second = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=followup, expected_revision=4, cancel_event_id="redelivery-4")
    assert second == first


@pytest.mark.asyncio
async def test_followup_insert_race_recovers_existing_same_revision():
    repo = RaceRepository()
    scheduler = SocialFollowupScheduler(repo)
    task_id = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FollowUp("check", "new"), expected_revision=7, cancel_event_id="first")
    assert task_id == "social-followup-" + scheduler._key(SCOPE, 7)


@pytest.mark.parametrize("delay", [0, -1, True, 1.5])
def test_followup_default_delay_must_be_positive_integer(delay):
    with pytest.raises(ValueError, match="positive integer"):
        SocialFollowupScheduler(FakeRepository(), default_delay_seconds=delay)


@pytest.mark.asyncio
async def test_running_followup_is_never_cancelled():
    repo = FakeRepository()
    scheduler = SocialFollowupScheduler(repo)
    task_id = await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FollowUp("check", "new"), expected_revision=1, cancel_event_id="event-1")
    repo.active[task_id] = "running"
    assert await scheduler.cancel_for_creator_event(SCOPE, "event-2") == []


@pytest.mark.asyncio
async def test_past_not_before_is_rejected_and_cross_scope_is_preserved():
    repo = FakeRepository()
    scheduler = SocialFollowupScheduler(repo)
    with pytest.raises(ValueError, match="future"):
        await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FollowUp("check", "new", (datetime.now(UTC) - timedelta(minutes=1)).isoformat()), expected_revision=2, cancel_event_id="event-2")
    await scheduler.schedule(SCOPE, thread_id="thread-1", followup=FollowUp("check", "new"), expected_revision=2, cancel_event_id="event-2")
    other_scope = SocialScope("owner", "account", "creator", "other-thread")
    assert await scheduler.cancel_for_creator_event(other_scope, "event-3") == []
