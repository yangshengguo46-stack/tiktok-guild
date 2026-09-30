"""Exercise production social assembly/commit and management in isolated SQLite."""

import asyncio
import json
import sys
import tempfile
import time
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from deerflow.persistence.base import Base
from deerflow.persistence.social import BoundaryUpdate, ExternalEvent, SocialRepository
from deerflow.social.assets import load_social_kernel
from deerflow.social.contracts import IdentityProfile, RoleProfile, SocialScope
from deerflow.social.persona.generator import PersonaProfileGenerator
from deerflow.social.persona.models import ProfileScope
from deerflow.social.persona.selector import AutomaticPersonaSelector
from deerflow.social.runtime import TURN_OUTPUT_PROMPT, SocialRuntime, SocialRuntimeBinding, SocialTurnMiddleware
from deerflow.social.tools import OperatorManagementCapability, ProfileManagement

from .intelligence_cases import evaluate_runtime_fixture


class Budget:
    def __init__(self, maximum, timeout, transport):
        self.maximum, self.timeout, self.transport = maximum, timeout, transport
        self.calls = []
        self.failed = False

    async def request(self, stage, messages):
        if self.failed:
            raise RuntimeError("preflight stopped after model failure")
        if len(self.calls) >= self.maximum:
            self.failed = True
            raise RuntimeError("model call budget exhausted")
        row = {"stage": stage, "usage": None, "cost_usd": "unknown", "status": "running"}
        self.calls.append(row)
        start = time.monotonic()
        try:
            result = await asyncio.wait_for(self.transport(messages), timeout=self.timeout)
            row.update(result, status="ok")
            return AIMessage(content=result["content"], usage_metadata=result.get("usage"))
        except BaseException as error:
            self.failed = True
            row.update(status="failed", error=type(error).__name__)
            raise
        finally:
            row["elapsed_seconds"] = round(time.monotonic() - start, 3)


class MeasuredModel(BaseChatModel):
    budget: Any
    stage: str

    @property
    def _llm_type(self):
        return "bounded-social-preflight"

    def _generate(self, messages, **kwargs):
        raise RuntimeError("preflight requires async execution")

    async def _agenerate(self, messages, **kwargs):
        message = await self.budget.request(self.stage, messages)
        return ChatResult(generations=[ChatGeneration(message=message)])


async def subprocess_transport(args, messages):
    process = await asyncio.create_subprocess_exec(sys.executable, "-m", "scripts.benchmark.social_preflight.transport", stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    payload = {"live": True, "config": str(args.config.resolve()), "model": args.model, "messages": [{"type": message.type, "content": message.content} for message in messages]}
    try:
        stdout, _stderr = await process.communicate(json.dumps(payload, ensure_ascii=False).encode())
        result = json.loads(stdout)
        if process.returncode or "error" in result:
            raise RuntimeError("model transport failed: " + str(result.get("error", "UnknownError")))
        return result
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


async def social_turn(repo, budget, person, index, text, history, *, source_kind="creator_message"):
    scope = SocialScope("preflight-owner", "preflight-account", person, "synthetic-channel")
    event_id = f"{person}-{index}"
    source = f"synthetic:{event_id}"
    snapshot = await repo.record_event(scope, ExternalEvent(event_id, source, source_kind, text))
    if not snapshot.identity_verified:
        await repo.set_boundaries(scope, expected_revision=snapshot.revision, update=BoundaryUpdate(True, False, False, (source,)))
    selector = AutomaticPersonaSelector(MeasuredModel(budget=budget, stage=f"{event_id}:selector"), timeout_seconds=budget.timeout + 1)
    binding = SocialRuntimeBinding(
        repo,
        scope,
        IdentityProfile("synthetic-ai", "1", "合成测试AI", "ai_agent", "合成测试公会", "我是AI，代表合成测试公会。", ()),
        RoleProfile("guild", "1", "自然交流；被问到岗位时如实回答，未知事实不编造。", ("conversation",), "synthetic-test-only"),
        event_id,
        frozenset(),
        selector,
    )
    runtime = SocialRuntime(binding)
    middleware = SocialTurnMiddleware(runtime)
    request = ModelRequest(
        model=MeasuredModel(budget=budget, stage=f"{event_id}:reply"),
        messages=[SystemMessage(content=load_social_kernel() + "\n\n" + TURN_OUTPUT_PROMPT), *history, HumanMessage(content=text)],
        tools=[],
        state={"social": {"scope": asdict(scope)}},
        runtime=SimpleNamespace(context={}),
        model_settings={},
    )

    async def handler(prepared):
        assert prepared.tools == []
        return ModelResponse(result=[await prepared.model.ainvoke(prepared.messages, stream=False)])

    await middleware.awrap_model_call(request, handler)
    if budget.failed or runtime.result is None:
        raise RuntimeError("social turn did not commit; no automatic retry")
    saved = await repo.restore(scope)
    history.extend([HumanMessage(content=text), AIMessage(content=runtime.result.reply or "")])
    return {
        "case": event_id,
        "input": text,
        "reply": runtime.result.reply,
        "claims": list(saved.claims),
        "profile": saved.effective_persona.profile_ref,
        "fingerprint": saved.effective_persona.fingerprint,
        "persona_evaluation": saved.persona_evaluation,
        "outbound_states": [item.state for item in saved.outbound],
    }


async def run_cases(repo, budget, results=None):
    results = [] if results is None else results
    history = []
    for index, text in enumerate(
        (
            "跟我聊天请直接简短，别绕弯也别逗我。今天收拾房间，翻出了大学时的旧照片，有点感慨。",
            "刚说的旧照片里有个很久没联系的朋友。我不想听建议，只觉得照片把时间按住了一下。",
            "换个话题，你怎么看玩游戏为了通关查攻略？我既怕错过，也怕没惊喜。",
        )
    ):
        results.append(await social_turn(repo, budget, "conversation", index, text, history))
    for occupation in ("主播", "程序员"):
        results.append(await social_turn(repo, budget, occupation, 0, f"我是{occupation}。今天整理房间翻到了旧照片，看见小时候乱剪的刘海，有点想笑。", []))

    requirement = "为本次合成验收生成一个简短、少追问、坦诚不说教的表达变体，只更改表达。"
    capability = OperatorManagementCapability("preflight-owner", "synthetic-management", operator_messages={"request": requirement})
    context = {"__social_management": capability, "user_id": "preflight-owner", "channel_name": "chat", "thread_id": "synthetic-management"}
    operator = SimpleNamespace(context=context, config={}, state={"messages": [HumanMessage(id="request", content=requirement)]})
    management = ProfileManagement(repo, capability=capability, generator=PersonaProfileGenerator(MeasuredModel(budget=budget, stage="management:generate"), timeout_seconds=budget.timeout + 1))
    scope = ProfileScope("preflight-owner", "preflight-account")
    baseline = await management.bind_profile(operator, scope, "relaxed_wit@1.0.1", expected_revision=0, reason="synthetic baseline")
    generated = await management.generate_profile(
        operator,
        scope,
        base_profile_ref="relaxed_wit@1.0.1",
        profile_id="preflight-generated",
        version="1",
        requirement=requirement,
        source_message_id="request",
        basis_refs=(),
        expected_revision=0,
        expected_binding_revision=baseline["write_revision"],
        reason="explicit synthetic activation",
        activate=True,
    )
    results.append({"case": "generation_activation", "receipt": generated})
    # An operator note intentionally does not trigger automatic template selection.
    active_turn = await social_turn(repo, budget, "generated", 0, "合成试读：朋友说修好的旧台灯终于又亮了。你会怎么接话？", [], source_kind="operator_note")
    if active_turn["profile"] != "preflight-generated@1":
        raise RuntimeError("generated profile did not reach the real social request")
    results.append(active_turn)
    rollback = await management.rollback_binding(operator, scope, target_revision=baseline["write_revision"], expected_revision=generated["write_revision"], reason="restore synthetic baseline")
    results.append({"case": "rollback", "receipt": rollback, "effective": await management.resolve_profile(scope)})
    return results


async def run_live(args):
    budget = Budget(args.max_calls, args.timeout, lambda messages: subprocess_transport(args, messages))
    report = {
        "complete": False,
        "boundary": "production SocialRuntime + SocialTurnMiddleware + SQLite; synthetic inputs; no Gateway, MCP, platform or real receipts",
        "model_alias": args.model,
        "calls": budget.calls,
        "results": [],
        "cost_usd": "unknown",
    }
    with tempfile.TemporaryDirectory(prefix="deerflow-social-preflight-") as directory:
        engine = create_async_engine(f"sqlite+aiosqlite:///{Path(directory) / 'social.db'}")
        try:
            async with engine.begin() as connection:
                await connection.run_sync(Base.metadata.create_all)
            repository = SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
            fixtures = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "social_intelligence"
            report["intelligence"] = [await evaluate_runtime_fixture(path, repository) for path in sorted(fixtures.glob("creator_*.json"))]
            await run_cases(repository, budget, report["results"])
            report["complete"] = True
        except Exception as error:
            report["error"] = type(error).__name__
        finally:
            await engine.dispose()
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
