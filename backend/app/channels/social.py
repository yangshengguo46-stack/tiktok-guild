"""Host-only social connection values. No production social provider is installed."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from types import MappingProxyType

from deerflow.persistence.social import ExternalEvent, SocialRepository
from deerflow.social.contracts import IdentityProfile, RoleProfile, SocialScope, bounded_text
from deerflow.social.roleos_binding import RoleOSBinding, validate_roleos_binding

SOCIAL_CAPABILITY_MATRIX = MappingProxyType({"tiktok": MappingProxyType({"inbound": "unverified", "outbound": "unverified", "receipts": "unverified"})})
_ENVELOPE_AUTHORITY = object()


@dataclass(frozen=True)
class SocialInternalWork:
    """Host-authenticated RoleOS work projected into one social turn.

    The work envelope carries business input only.  Scope, account, owner,
    provider, persona, relationship, and MCP authority remain on the
    registered :class:`SocialConnection` and are never accepted here.
    """

    request_id: str
    objective: str
    input_refs: tuple[str, ...] = ()
    artifact_refs: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        bounded_text(self.request_id, "request_id", 128)
        bounded_text(self.objective, "objective", 32_000)
        for name, refs in (("input_refs", self.input_refs), ("artifact_refs", self.artifact_refs)):
            if not isinstance(refs, tuple) or len(refs) > 64 or any(not isinstance(ref, str) or not ref.strip() or len(ref) > 2_048 for ref in refs):
                raise ValueError(f"{name} must be a bounded tuple of references")
            if len(set(refs)) != len(refs):
                raise ValueError(f"{name} must not contain duplicates")

    def event_ids(self, scope: SocialScope) -> tuple[str, str]:
        """Return deterministic event/source refs for idempotent admission."""
        digest = hashlib.sha256(f"{scope.owner_user_id}:{scope.account_id}:{scope.person_ref}:{scope.channel_thread_ref}:{scope.agent_instance_id}:{self.request_id}".encode()).hexdigest()
        return f"roleos:{digest}", f"roleos:{hashlib.sha256((digest + ':source').encode()).hexdigest()}"

    def external_event(self, scope: SocialScope) -> ExternalEvent:
        event_id, source_ref = self.event_ids(scope)
        return ExternalEvent(event_id, source_ref, "operator_note", self.objective)


@dataclass(frozen=True)
class SocialCapabilities:
    inbound: bool = False
    outbound: bool = False
    receipts: bool = False

    def __post_init__(self):
        if any(type(value) is not bool for value in (self.inbound, self.outbound, self.receipts)):
            raise ValueError("capabilities must be host-owned booleans")


@dataclass(frozen=True)
class AuthenticatedSocialEvent:
    """A provider-authenticated event, never constructed from free-form metadata.

    The adapter must verify provider signature/session and creator authorship
    before returning this value from authenticate_social_event.
    """

    event_id: str
    text: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    source_kind: str

    def __post_init__(self):
        for name in ("event_id", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        bounded_text(self.text, "text", 16384)
        if self.source_kind not in {"creator_message", "operator_note", "platform_observation"}:
            raise ValueError("invalid social source kind")


@dataclass(frozen=True)
class SocialConnection:
    """Operator-provisioned connection resolution, supplied by host code only.

    thread_id is an existing native Gateway thread. These values are not
    read from channel session config, remote messages, or provider text.
    """

    repository: SocialRepository
    scope: SocialScope
    identity: IdentityProfile
    role: RoleProfile
    thread_id: str
    provider: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    channel_safe_tool_names: frozenset[str] = frozenset()
    identity_verified: bool = False
    creator_evidence: tuple = ()
    conversation_goal: str | None = None
    schedule_followup: object | None = None
    roleos_binding: RoleOSBinding | None = None

    def __post_init__(self):
        if not isinstance(self.repository, SocialRepository) or not isinstance(self.scope, SocialScope) or not isinstance(self.identity, IdentityProfile) or not isinstance(self.role, RoleProfile):
            raise ValueError("social connections require canonical host-owned values")
        if type(self.identity_verified) is not bool:
            raise ValueError("person identity verification must be a host-owned boolean")
        for name in ("thread_id", "provider", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        if not isinstance(self.channel_safe_tool_names, frozenset) or any(not isinstance(name, str) or not name for name in self.channel_safe_tool_names):
            raise ValueError("channel-safe tools must be a host-owned frozenset")
        if not isinstance(self.creator_evidence, tuple):
            raise ValueError("creator_evidence must be a host-owned tuple")
        from deerflow.social.intelligence import CreatorEvidence

        if any(not isinstance(item, CreatorEvidence) or item.scope != self.scope for item in self.creator_evidence):
            raise ValueError("creator_evidence must contain scoped CreatorEvidence values")
        if self.roleos_binding is not None:
            validate_roleos_binding(self.roleos_binding, thread_id=self.thread_id, assistant_id=self.scope.agent_instance_id)


@dataclass(frozen=True)
class SocialInboundEnvelope:
    scope: SocialScope
    source_event_id: str
    source_kind: str
    identity_verified: bool
    provider_receipt_capability: str
    _authority: object = field(repr=False, compare=False)

    def __post_init__(self):
        if self._authority is not _ENVELOPE_AUTHORITY:
            raise ValueError("only authenticated ChannelManager resolution may mint envelopes")


@dataclass(frozen=True)
class SocialProviderResult:
    """Actual provider acknowledgement; delivered requires a receipt reference.

    rejected means a definitive provider refusal. Exceptions/timeouts, None,
    malformed responses and unsupported acknowledgement levels stay unknown.
    """

    state: str
    provider_ref: str | None
    evidence_ref: str | None
    receipt_ref: str | None = None

    def __post_init__(self):
        if self.state not in {"accepted", "delivered", "rejected", "unknown"}:
            raise ValueError("invalid provider acknowledgement")
        for name in ("provider_ref", "evidence_ref", "receipt_ref"):
            value = getattr(self, name)
            if value is not None:
                bounded_text(value, name, 128)


@dataclass(frozen=True)
class AuthenticatedSocialReceipt:
    receipt_id: str
    action_id: str
    external_account_id: str
    workspace_id: str
    chat_id: str
    result: SocialProviderResult

    def __post_init__(self):
        for name in ("receipt_id", "action_id", "external_account_id", "workspace_id", "chat_id"):
            bounded_text(getattr(self, name), name, 128)
        if not isinstance(self.result, SocialProviderResult) or self.result.evidence_ref != self.receipt_id:
            raise ValueError("authenticated receipt must carry its provider evidence reference")
        if self.result.state == "delivered" and self.result.receipt_ref != self.receipt_id:
            raise ValueError("delivery requires the authenticated provider receipt")
