"""RoleOS binding invariants exercised by the Guild host."""

from dataclasses import FrozenInstanceError

import pytest

from deerflow.social.roleos_binding import RoleOSBinding, validate_roleos_binding


def _binding() -> RoleOSBinding:
    return RoleOSBinding("roleos", "sales", "sales", "sales", "roleos:sales", "lead_agent", "social-thread", "roleos-r1")


def test_roleos_binding_is_frozen_and_validates_native_target():
    binding = _binding()
    assert validate_roleos_binding(binding, thread_id="social-thread", assistant_id="lead_agent") is binding
    with pytest.raises(FrozenInstanceError):
        binding.member_id = "attacker"
    with pytest.raises(ValueError):
        validate_roleos_binding(binding, thread_id="other-thread")


def test_roleos_binding_rejects_untyped_values():
    with pytest.raises(ValueError):
        validate_roleos_binding({"member_id": "sales"})
