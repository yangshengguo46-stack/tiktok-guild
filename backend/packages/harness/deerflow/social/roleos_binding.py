"""Trusted RoleOS employee identity carried by a native social run.

The binding is created by the host admission layer. It is deliberately a
small immutable value: RoleOS identifies the employee and company, while the
native social runtime continues to own scopes, persistence, tools, and
provider actions.
"""

from __future__ import annotations

from dataclasses import dataclass

from deerflow.social.contracts import bounded_text

ROLEOS_BINDING_CONTEXT_KEY = "__roleos_binding"


@dataclass(frozen=True, slots=True)
class RoleOSBinding:
    """Host-created company identity for one native employee run."""

    company_id: str
    department_id: str
    source_role: str
    member_id: str
    native_owner_id: str
    assistant_id: str
    thread_id: str
    source_revision: str

    def __post_init__(self) -> None:
        for name in (
            "company_id",
            "department_id",
            "source_role",
            "member_id",
            "native_owner_id",
            "assistant_id",
            "thread_id",
            "source_revision",
        ):
            bounded_text(getattr(self, name), name, 128)


def validate_roleos_binding(
    binding: RoleOSBinding,
    *,
    thread_id: str | None = None,
    assistant_id: str | None = None,
) -> RoleOSBinding:
    """Validate host expectations before exposing identity to a run."""

    if not isinstance(binding, RoleOSBinding):
        raise ValueError("RoleOS identity requires a typed host binding")
    if thread_id is not None and binding.thread_id != thread_id:
        raise ValueError("RoleOS binding thread does not match native run")
    if assistant_id is not None and binding.assistant_id != assistant_id:
        raise ValueError("RoleOS binding assistant does not match native run")
    return binding
