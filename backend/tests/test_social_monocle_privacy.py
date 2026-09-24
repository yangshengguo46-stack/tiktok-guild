"""Process-global Monocle must never instrument private social model calls."""

import asyncio
import importlib.util
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("mode", ["setup_completed", "installed_stale_flag", "env_before_setup", "cached_config", "setup_flag_only", "optional_absent"])
def test_monocle_social_preflight_in_isolated_process(mode, tmp_path):
    if mode in {"setup_completed", "installed_stale_flag"} and importlib.util.find_spec("monocle_apptrace") is None:
        pytest.skip("optional Monocle package not installed")
    script = "import asyncio, sys; sys.path.insert(0, sys.argv[1]); from test_social_monocle_privacy import run_scenario; asyncio.run(run_scenario(sys.argv[2], sys.argv[3]))"
    env = {name: value for name, value in os.environ.items() if not name.startswith(("MONOCLE_", "LANGCHAIN_", "LANGSMITH_", "LANGFUSE_", "OTEL_"))}
    result = subprocess.run([sys.executable, "-c", script, str(Path(__file__).parent), mode, str(tmp_path)], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "MONOCLE_PRIVACY_OK" in result.stdout


async def run_scenario(mode, directory):
    """Run real setup/Lead/repository in a disposable child process only."""
    from langchain_core.messages import AIMessage, HumanMessage
    from langchain_core.runnables.config import var_child_runnable_config
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
    from test_social_lead_runtime import SCOPE, assembly, install_host_journal, private_fixture_model

    from deerflow.config.tracing_config import get_tracing_config, reset_tracing_config
    from deerflow.persistence.base import Base
    from deerflow.persistence.social import BoundaryUpdate, ExternalEvent, SocialRepository
    from deerflow.runtime.events.store.memory import MemoryRunEventStore
    from deerflow.runtime.journal import RunJournal
    from deerflow.social.persona.selector import AutomaticPersonaSelector
    from deerflow.tracing import monocle as native_monocle

    logs = []

    class CaptureWarning(logging.Handler):
        def emit(self, record):
            logs.append(record.getMessage())

    logging.getLogger("deerflow.runtime.private_model").addHandler(CaptureWarning())
    engine = create_async_engine(f"sqlite+aiosqlite:///{Path(directory) / 'social.db'}")
    monkeypatch = pytest.MonkeyPatch()
    journal = RunJournal("monocle", "monocle", MemoryRunEventStore(), flush_threshold=1)
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        repo = SocialRepository(async_sessionmaker(engine, expire_on_commit=False))
        await repo.record_event(SCOPE, ExternalEvent("e1", "ref1", "creator_message", "hello"))
        await repo.set_boundaries(SCOPE, expected_revision=1, update=BoundaryUpdate(True, False, False, ("ref1",)))
        main, main_calls = private_fixture_model(AIMessage(content='{"reply":"committed-visible","decision_note":"PRIVATE_DECISION"}'))
        selection, selector_calls = private_fixture_model(AIMessage(content='{"action":"stay","persona_id":"relaxed_wit","confidence":1,"evidence_refs":["ref1"],"reason":"PRIVATE_SELECTOR"}'))
        graph, config = await assembly(monkeypatch, repo, main, binding_changes={"selector": AutomaticPersonaSelector(selection)})
        install_host_journal(config, journal)
        exporter = None
        instrumentor = None
        if mode == "optional_absent":
            # An absent optional dependency must neither be imported nor required.
            monkeypatch.setitem(sys.modules, "monocle_apptrace", None)
        elif mode == "setup_flag_only":
            monkeypatch.setattr(native_monocle, "_setup_completed", True)
        else:
            monkeypatch.setenv("MONOCLE_TRACING", "true")
            reset_tracing_config()
            if mode == "cached_config":
                assert get_tracing_config().monocle.enabled
                monkeypatch.delenv("MONOCLE_TRACING")
            elif mode in {"setup_completed", "installed_stale_flag"}:
                from monocle_apptrace.instrumentation.common import instrumentor as monocle_instrumentor
                from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

                exporter = InMemorySpanExporter()
                # Keep actual native setup, wrappers, provider, span processors
                # and span extraction; only exporter transport becomes memory.
                monkeypatch.setattr(monocle_instrumentor, "get_monocle_exporter", lambda *args: [exporter])
                assert await asyncio.to_thread(native_monocle.setup_monocle_tracing_if_enabled)
                instrumentor = monocle_instrumentor.get_monocle_instrumentor()
                assert instrumentor is not None and instrumentor.is_instrumented_by_opentelemetry
                monkeypatch.delenv("MONOCLE_TRACING")
                reset_tracing_config()
                if mode == "installed_stale_flag":
                    monkeypatch.setattr(native_monocle, "_setup_completed", False)
        original = var_child_runnable_config.get()
        result = await graph.ainvoke({"messages": [HumanMessage(content="hello")]}, config)
        assert var_child_runnable_config.get() is original
        if exporter is not None:
            monocle_instrumentor.get_tracer_provider().force_flush()
            spans = repr([(span.name, dict(span.attributes), [(event.name, dict(event.attributes)) for event in span.events]) for span in exporter.get_finished_spans()])
            assert "PRIVATE_" not in spans and "Choose one supplied expression template" not in spans and "<social-runtime-data>" not in spans, spans
            assert journal._private_output_tag not in spans
            assert not any("BaseChatModel" in span.name for span in exporter.get_finished_spans())
        if mode == "optional_absent":
            assert len(main_calls) == len(selector_calls) == 1
            assert result["messages"][-1].content == "committed-visible" and len((await repo.restore(SCOPE)).outbound) == 1
            assert "monocle_apptrace.instrumentation.common.instrumentor" not in sys.modules
        else:
            assert main_calls == [] and selector_calls == []
            assert result["messages"][-1].content == "" and not (await repo.restore(SCOPE)).outbound
            assert any("Private model callbacks blocked" in message and "Monocle" in message for message in logs)
            assert not any("PRIVATE_" in message or journal._private_output_tag in message for message in logs)
        ordinary, ordinary_calls = private_fixture_model(AIMessage(content="ordinary-monocle-visible"))
        await ordinary.ainvoke([HumanMessage(content="ordinary input")])
        assert len(ordinary_calls) == 1
        if exporter is not None:
            monocle_instrumentor.get_tracer_provider().force_flush()
            assert monocle_instrumentor.get_monocle_instrumentor() is instrumentor
            assert instrumentor.is_instrumented_by_opentelemetry
            spans = repr([(span.name, dict(span.attributes), [(event.name, dict(event.attributes)) for event in span.events]) for span in exporter.get_finished_spans()])
            assert "ordinary-monocle-visible" in spans
        print("MONOCLE_PRIVACY_OK")
    finally:
        await journal.close()
        await engine.dispose()
        monkeypatch.undo()
