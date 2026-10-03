"""RoleOS company tools stay inside the native SocialRuntime owner."""


def host_peer_tools(binding, connection):
    import os
    from types import SimpleNamespace

    if not os.environ.get("ROLEOS_CONTROL_PLANE_URL") and not os.environ.get("ROLEOS_PEER_TOKEN_PATH"):
        return None
    try:
        from roleos.peer_tools import from_host_binding
    except ImportError as exc:
        raise RuntimeError("RoleOS peer tools require the shared roleos package installed in this native environment") from exc
    return from_host_binding(
        SimpleNamespace(
            company_id=binding.company_id,
            member_id=binding.member_id,
            department_id=binding.department_id,
            source_role=binding.source_role,
            source_revision=binding.source_revision,
            native_owner_id=binding.native_owner_id,
            assistant_id=connection.scope.agent_instance_id,
            thread_id=connection.thread_id,
        )
    )


def tools_for_runtime(runtime):
    if runtime is None or runtime.binding.peer_tools is None:
        return []
    from roleos.peer_tools import langchain_tools

    return langchain_tools(runtime.binding.peer_tools)
