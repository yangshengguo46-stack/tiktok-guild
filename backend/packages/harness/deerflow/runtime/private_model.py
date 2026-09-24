"""Task-local callback isolation for host-owned private model execution."""

import logging
from contextlib import contextmanager

from langchain_core.globals import get_debug, get_verbose
from langchain_core.language_models import BaseChatModel
from langchain_core.runnables.base import RunnableBinding
from langchain_core.runnables.config import ensure_config, var_child_runnable_config
from langchain_core.tracers.context import _configure_hooks, tracing_v2_callback_var
from langchain_core.utils.env import env_var_is_set
from langsmith import tracing_context

from deerflow.runtime.journal import RunJournal

logger = logging.getLogger(__name__)


def _check_auto_callbacks() -> None:
    """Reject auto callbacks which cannot be disabled with task-local config."""
    conditions = []
    if get_debug():
        conditions.append("LangChain global debug")
    if get_verbose():
        conditions.append("LangChain global verbose")
    for name in ("LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGSMITH_TRACING", "LANGCHAIN_HANDLER"):
        if env_var_is_set(name):
            conditions.append(name)
    for _, _, handler_class, env_var in _configure_hooks:
        if handler_class is not None and env_var is not None and env_var_is_set(env_var):
            conditions.append("registered callback environment: " + env_var)
    if conditions:
        # Names only: never log environment values, private inputs or capability.
        message = "Private model callbacks blocked; disable process-wide automatic tracing/debug callbacks for the social worker: " + ", ".join(conditions)
        logger.warning(message)
        raise ValueError(message)


def private_model_copy(model):
    """Remove model-local callbacks too, without mutating the native model."""
    if isinstance(model, BaseChatModel):
        return model.model_copy(update={"callbacks": None, "verbose": False})
    if isinstance(model, RunnableBinding):
        return model.model_copy(update={"bound": private_model_copy(model.bound), "config": {key: value for key, value in model.config.items() if key != "callbacks"}})
    return model


@contextmanager
def private_model_callbacks(journal: RunJournal | None):
    """Replace inherited callbacks in this task's child config, never merge.

    Preserve native configurable/runtime values. ContextVar tokens restore the
    exact caller context on return, exception or cancellation; peer tasks are
    unaffected. Disable ambient LangSmith ancestry and context callback hooks.
    """
    _check_auto_callbacks()
    config = {**ensure_config(), "callbacks": [journal] if isinstance(journal, RunJournal) else []}
    config_token = var_child_runnable_config.set(config)
    trace_token = tracing_v2_callback_var.set(None)
    hook_tokens = [(var, var.set(None)) for var, *_ in _configure_hooks if var is not tracing_v2_callback_var]
    try:
        with tracing_context(enabled=False, parent=False, tags=[], metadata={}):
            yield config
    finally:
        for var, token in reversed(hook_tokens):
            var.reset(token)
        tracing_v2_callback_var.reset(trace_token)
        var_child_runnable_config.reset(config_token)
