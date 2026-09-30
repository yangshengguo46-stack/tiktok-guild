"""A server-bound social turn inside the native Lead model/tool graph."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from langchain.agents.middleware.types import ExtendedModelResponse, ModelResponse
from langchain_core.messages import AIMessage
from langgraph.constants import TAG_NOSTREAM
from langgraph.types import Command

from deerflow.persistence.social import SocialConflictError, SocialRepository
from deerflow.runtime.journal import RunJournal
from deerflow.runtime.private_model import private_model_callbacks, private_model_copy
from deerflow.social.context import RelationshipMemoryItem, RelationshipSnapshot, SelfMemoryItem, SocialContextSnapshot, TurnContext
from deerflow.social.contracts import ClaimPatch, IdentityProfile, RoleProfile, SocialScope, bounded_text
from deerflow.social.intelligence import ConversationPlan, ConversationStage, build_snapshot, plan_conversation
from deerflow.social.middleware import SocialContextMiddleware
from deerflow.social.persona.catalog import load_persona_catalog
from deerflow.social.persona.models import ProfileScope
from deerflow.social.persona.selector import AutomaticPersonaSelector
from deerflow.social.turns import commit_turn, contact_blocked, parse_turn_result, private_output_text, receipt_status
from deerflow.utils.file_io import run_file_io

TURN_OUTPUT_PROMPT = (
    "You are the server-bound social agent described in the social context. Use only the supplied channel-safe tools. "
    "On every model call, including after earlier visible turns, return exactly one JSON object; do not continue in plain text. "
    "Return exactly one JSON object with required reply (string or null), optional state_delta (at most 16 claim patches), "
    "optional memory_delta (at most 16 evidence-backed memory candidates), "
    "decision_note (at most 240 characters), and followup (check, cancel_when, optional ISO-8601 not_before). "
    "Each claim patch has op assert/retract, claim_id and evidence_ids. Assertions also require text, kind "
    "(reported/observed/hypothesis) and facet (person/tradeoff/relationship/conversation/shared_topic/next_step). "
    "Use only provided source references. memory_delta is a proposal for durable context only and is never authoritative for identity, boundaries, or platform receipts. "
    "Null reply with followup means wait; null without it means intentional silence. "
    "Do not add any other fields. Identity, memories, commitments, permissions and bindings cannot be rewritten by persona expression."
)


@dataclass(frozen=True)
class SocialRuntimeBinding:
    """Host capability object: JSON/dict runtime context cannot construct this."""

    repository: SocialRepository
    scope: SocialScope
    identity: IdentityProfile
    role: RoleProfile
    event_id: str
    channel_safe_tool_names: frozenset[str] = frozenset()
    selector: Any = None
    creator_evidence: tuple = ()
    conversation_goal: str | None = None
    schedule_followup: Any = None

    def __post_init__(self):
        if not isinstance(self.repository, SocialRepository) or not isinstance(self.scope, SocialScope) or not isinstance(self.identity, IdentityProfile) or not isinstance(self.role, RoleProfile):
            raise ValueError("social binding requires host-owned repository and canonical profiles")
        bounded_text(self.event_id, "event_id", 128)
        if not isinstance(self.channel_safe_tool_names, frozenset) or any(not isinstance(name, str) or not name for name in self.channel_safe_tool_names):
            raise ValueError("channel-safe tools must be a host-owned frozenset")
        if not isinstance(self.creator_evidence, tuple):
            raise ValueError("creator_evidence must be a host-owned tuple")
        from deerflow.social.intelligence import CreatorEvidence

        if any(not isinstance(item, CreatorEvidence) or item.scope != self.scope for item in self.creator_evidence):
            raise ValueError("creator_evidence must contain scoped CreatorEvidence values")
        if self.conversation_goal is not None:
            bounded_text(self.conversation_goal, "conversation_goal", 512)
        if self.schedule_followup is not None and not callable(self.schedule_followup):
            raise ValueError("schedule_followup must be callable")


def binding_for_lead(config, *, user_id):
    context = config.get("context") or {}
    configurable = config.get("configurable") or {}
    requested = context.get("social_mode", configurable.get("social_mode", False))
    if requested is not True:
        return None
    binding = context.get("__social_binding")
    if not isinstance(binding, SocialRuntimeBinding) or binding.scope.owner_user_id != user_id:
        raise ValueError("social mode requires a server-bound scope and matching owner")
    if context.get("is_bootstrap", configurable.get("is_bootstrap", False)):
        raise ValueError("social mode cannot bootstrap an agent")
    return binding


def _memory(row):
    return SelfMemoryItem(row["memory_id"], {"self_statement": "statement", "self_viewpoint": "viewpoint", "commitment": "commitment"}[row["category"]], row["text"], tuple(row["evidence_ids"]), row["status"])


class SocialRuntime:
    """One bound event per assembly. Persistent facts always come from the repository."""

    def __init__(self, binding: SocialRuntimeBinding, *, app_config=None, model_name=None):
        self.binding = binding
        self.repository = binding.repository
        self.snapshot = None
        self.context = None
        self.result = None
        self.finished = False
        self._app_config = app_config
        self._model_name = model_name

    async def restore_context(self, *, journal: RunJournal | None = None):
        snapshot = await self.repository.restore(self.binding.scope)
        event = next((event for event in snapshot.events if event["source_event_id"] == self.binding.event_id), None)
        if event is None:
            raise ValueError("bound turn event does not exist in this scope")
        if await self.repository.is_turn_committed(self.binding.scope, self.binding.event_id):
            self.finished = True
        if not self.finished and not contact_blocked(snapshot) and event["source_kind"] == "creator_message":
            profile_scope = ProfileScope(self.binding.scope.owner_user_id, self.binding.scope.account_id, self.binding.scope.agent_instance_id, self.binding.scope.person_ref)
            claim = await self.repository.claim_persona_evaluation(self.binding.scope, expected_revision=snapshot.revision, event_id=self.binding.event_id, expected_binding_generation=snapshot.effective_persona.binding_revision)
            if claim is not None:
                selector = self.binding.selector or AutomaticPersonaSelector(model_name=self._model_name, app_config=self._app_config)
                choice = await selector.choose(
                    scope=profile_scope,
                    current_profile_ref=snapshot.effective_persona.profile_ref,
                    candidates=await run_file_io(load_persona_catalog),
                    evidence=[{**event, **asdict(profile_scope), "evidence_version": snapshot.revision}],
                    evidence_version=snapshot.revision,
                    evaluated_evidence_version=snapshot.evaluated_persona_evidence_version,
                    binding_revision=snapshot.effective_persona.binding_revision,
                    private_journal=journal,
                )
                snapshot = await self.repository.finish_persona_evaluation(claim, choice=choice)
            else:
                current = await self.repository.restore(self.binding.scope)
                if current.revision != snapshot.revision or current.effective_persona.fingerprint != snapshot.effective_persona.fingerprint:
                    raise SocialConflictError(current)
                snapshot = current
        self.snapshot = snapshot
        claims = tuple(ClaimPatch("assert", row["claim_id"], tuple(row["evidence_ids"]), row["text"], row["kind"], row["facet"]) for row in snapshot.claims if row["status"] == "active")
        conversation_plan: ConversationPlan | None = None
        intelligence = None
        if self.binding.creator_evidence:
            intelligence = build_snapshot(self.binding.scope, self.binding.creator_evidence, snapshot.revision)
            try:
                stage = ConversationStage(snapshot.conversation_stage)
            except (AttributeError, ValueError):
                stage = ConversationStage.first_contact
            consent_refs = tuple(
                event_row["source_ref"]
                for event_row in snapshot.events
                if event_row.get("source_kind") == "creator_message"
                and isinstance(event_row.get("creator_consent"), dict)
                and event_row["creator_consent"].get("purpose") == "formal_invite"
                and event_row["creator_consent"].get("granted") is True
                and event_row["creator_consent"].get("source_ref") == event_row.get("source_ref")
            )
            conversation_plan = plan_conversation(intelligence, stage=stage, goal=self.binding.conversation_goal, consent_evidence_ids=consent_refs)
        elif snapshot.conversation_plan is not None:
            # A later native Lead may not have the public-evidence adapter
            # available.  Rehydrate the last host projection only after strict
            # shape validation; malformed/stale stage data fails closed rather
            # than silently disappearing from context.
            try:
                persisted = ConversationPlan.from_payload(snapshot.conversation_plan)
                if persisted.stage.value != snapshot.conversation_stage:
                    raise ValueError("persisted plan stage does not match funnel stage")
                conversation_plan = persisted
            except (TypeError, ValueError) as exc:
                raise ValueError("persisted conversation_plan failed validation") from exc
        creator_sources = () if intelligence is None else tuple(item.source_metadata() for group in (intelligence.identity, intelligence.works, intelligence.signals) for item in group)
        self.context = SocialContextSnapshot(
            self.binding.scope,
            self.binding.identity,
            self.binding.role,
            tuple(_memory(row) for row in snapshot.self_state),
            RelationshipSnapshot(
                snapshot.revision,
                claims,
                (),
                (),
                tuple(_memory(row) for row in snapshot.commitments),
                snapshot.do_not_contact,
                snapshot.human_takeover,
                snapshot.identity_verified,
                receipt_status(snapshot),
                notes=tuple(RelationshipMemoryItem(row["memory_id"], row["text"], tuple(row["evidence_ids"]), row["status"]) for row in snapshot.relationship),
            ),
            snapshot.effective_persona,
            TurnContext(event["source_event_id"], event["text"][:4096], tuple(row["text"][:512] for row in snapshot.events[-9:] if row["source_event_id"] != event["source_event_id"]), (), {}, source_ref=event["source_ref"]),
            conversation_plan,
            creator_sources,
        )
        return self.context

    def snapshot_for(self, scope):
        if self.context is None or scope != self.binding.scope:
            raise ValueError("social scope is not restored")
        return self.context


class SocialTurnMiddleware(SocialContextMiddleware):
    """One context injector and one commit boundary; raw output never enters state."""

    def __init__(self, runtime, *, safety_guard=None):
        super().__init__(runtime=runtime, bound_scope=runtime.binding.scope)
        self._safety_guard = safety_guard

    def release_policy_parameters(self):
        return {
            "channel_safe_tool_names": sorted(self._runtime.binding.channel_safe_tool_names),
            "output_contract": "TurnResult",
            "commit_before_disclosure": True,
            "selector_attempt_policy": "durable-no-retry",
            "safety": self._safety_guard.release_policy_parameters() if self._safety_guard is not None else None,
        }

    async def abefore_agent(self, state, runtime):
        scope = asdict(self._bound_scope)
        social = state.get("social")
        if social is not None and social.get("scope") != scope:
            raise ValueError("checkpoint scope differs from server binding")
        return {"social": {"scope": scope}}

    def wrap_model_call(self, request, handler):
        raise ValueError("social turns require async invocation for native persistence")

    async def awrap_model_call(self, request, handler):
        runtime = self._runtime
        context = getattr(request.runtime, "context", None)
        journal = context.get("__run_journal") if isinstance(context, dict) else None
        if not isinstance(journal, RunJournal):
            journal = None
        if runtime.finished:
            return ModelResponse(result=[AIMessage(content="")])
        if runtime.snapshot is None:
            try:
                await runtime.restore_context(journal=journal)
            except SocialConflictError:
                runtime.snapshot = await runtime.repository.restore(runtime.binding.scope)
                runtime.finished = True
        if runtime.finished or contact_blocked(runtime.snapshot):
            runtime.finished = True
            return ModelResponse(result=[AIMessage(content="")])
        current = await runtime.repository.restore(runtime.binding.scope)
        if contact_blocked(current) or current.revision != runtime.snapshot.revision or current.effective_persona.fingerprint != runtime.snapshot.effective_persona.fingerprint:
            runtime.snapshot = current
            runtime.finished = True
            return ModelResponse(result=[AIMessage(content="")])
        request = self._inject(request)
        # The normal create_agent handler still binds tools and invokes the same
        # model. Suppress its callbacks, including nonstreaming on_llm_end frames.
        private_tags = [journal._private_output_tag] if journal is not None and journal._private_output_tag is not None else []
        model = private_model_copy(request.model).model_copy(update={"tags": [*(request.model.tags or []), TAG_NOSTREAM, *private_tags], "disable_streaming": True})
        try:
            with private_model_callbacks(journal):
                response = await handler(request.override(model=model, model_settings={**request.model_settings, "stream": False}))
        except Exception:
            # Provider exceptions may embed raw model content. Do not propagate
            # it through root chain-error/history callbacks or retry generation.
            runtime.finished = True
            return ModelResponse(result=[AIMessage(content="")])
        message = response.result[-1]
        if not isinstance(message, AIMessage):
            raise ValueError("social model must return an assistant message")
        if message.invalid_tool_calls or (self._safety_guard is not None and self._safety_guard._detect(message) is not None):
            runtime.finished = True
            return ModelResponse(result=[AIMessage(content="")])
        if message.tool_calls:
            return ModelResponse(result=[AIMessage(content="", tool_calls=message.tool_calls, id=message.id)])
        runtime.finished = True
        try:
            result = parse_turn_result(private_output_text(message.content))
            saved = await commit_turn(runtime.repository, runtime.snapshot, event_id=runtime.binding.event_id, result=result, conversation_plan=runtime.context.conversation_plan)
        except (ValueError, TypeError, SocialConflictError):
            runtime.snapshot = await runtime.repository.restore(runtime.binding.scope)
            return ModelResponse(result=[AIMessage(content="")])
        runtime.result = result
        runtime.snapshot = saved.snapshot
        followup_schedule_error = None
        if result.followup is not None and runtime.binding.schedule_followup is not None and not contact_blocked(saved.snapshot):
            try:
                await runtime.binding.schedule_followup(
                    runtime.binding.scope,
                    thread_id=runtime.binding.scope.channel_thread_ref,
                    followup=result.followup,
                    expected_revision=saved.snapshot.revision,
                    cancel_event_id=runtime.binding.event_id,
                )
                if saved.snapshot.followup_schedule_error is not None:
                    runtime.snapshot = await runtime.repository.clear_followup_schedule_failure(runtime.binding.scope, expected_revision=saved.snapshot.revision)
                    saved = type(saved)(snapshot=runtime.snapshot, outbound=saved.outbound)
            except Exception as exc:
                # The social commit and generic scheduled-task insert are
                # separate native transactions. Preserve the committed
                # followup intent and leave a durable marker for a host-owned
                # reconciliation loop; do not turn a successful reply into a
                # second, non-idempotent model attempt.
                followup_schedule_error = f"{type(exc).__name__}: {str(exc)[:400]}"
                try:
                    runtime.snapshot = await runtime.repository.mark_followup_schedule_failure(runtime.binding.scope, expected_revision=saved.snapshot.revision, error=followup_schedule_error)
                    saved = type(saved)(snapshot=runtime.snapshot, outbound=saved.outbound)
                except Exception:
                    # The intent remains in the already committed snapshot;
                    # a later host restore can reconcile it conservatively.
                    pass
        progress = {"scope": asdict(runtime.binding.scope), "relationship_revision": saved.snapshot.revision, "self_revision": saved.snapshot.revision, "latest_external_event_id": runtime.binding.event_id}
        if saved.outbound:
            progress["pending_action_id"] = saved.outbound.action_id
        return ExtendedModelResponse(model_response=ModelResponse(result=[AIMessage(content=result.reply or "")]), command=Command(update={"social": progress}))


def middlewares_for_lead(runtime, middlewares):
    """Keep native sanitizers and permission wrappers; exclude operator side effects."""
    if any(isinstance(middleware, SocialContextMiddleware) for middleware in middlewares):
        raise ValueError("social assembly must own exactly one context middleware")
    safe_names = {
        "InputSanitizationMiddleware",
        "ToolOutputBudgetMiddleware",
        "ToolResultSanitizationMiddleware",
        "DanglingToolCallMiddleware",
        "GuardrailMiddleware",
        "SandboxAuditMiddleware",
        "ReadBeforeWriteMiddleware",
        "ToolErrorHandlingMiddleware",
    }
    # Unrecognized extensions may contain permission checks. Refuse assembly
    # rather than silently discarding a policy or letting it disclose raw JSON.
    operator_names = {
        "ThreadDataMiddleware",
        "UploadsMiddleware",
        "SandboxMiddleware",
        "LLMErrorHandlingMiddleware",
        "ToolReceiptMiddleware",
        "ToolProgressMiddleware",
        "DynamicContextMiddleware",
        "SkillActivationMiddleware",
        "DeferredToolPromotionAuditMiddleware",
        "SkillToolPolicyMiddleware",
        "DurableContextMiddleware",
        "DeerFlowSummarizationMiddleware",
        "TodoMiddleware",
        "TokenUsageMiddleware",
        "TitleMiddleware",
        "MemoryMiddleware",
        "ViewImageMiddleware",
        "McpRoutingMiddleware",
        "DeferredToolFilterMiddleware",
        "SystemMessageCoalescingMiddleware",
        "SubagentLimitMiddleware",
        "LoopDetectionMiddleware",
        "TokenBudgetMiddleware",
        "TerminalResponseMiddleware",
        "ModelLengthFinishReasonMiddleware",
        "SafetyFinishReasonMiddleware",
        "ClarificationMiddleware",
    }
    if any(type(middleware).__name__ not in safe_names | operator_names for middleware in middlewares):
        raise ValueError("unsupported social middleware; explicit channel policy integration is required")
    from deerflow.agents.middlewares.safety_finish_reason_middleware import SafetyFinishReasonMiddleware
    from deerflow.agents.middlewares.system_message_coalescing_middleware import SystemMessageCoalescingMiddleware

    safety_guard = next((middleware for middleware in middlewares if isinstance(middleware, SafetyFinishReasonMiddleware)), None)
    return [*[middleware for middleware in middlewares if type(middleware).__name__ in safe_names], SocialTurnMiddleware(runtime, safety_guard=safety_guard), SystemMessageCoalescingMiddleware()]
