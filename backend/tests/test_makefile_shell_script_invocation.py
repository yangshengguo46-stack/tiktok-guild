"""Regression test keeping repo shell scripts callable without the executable bit.

The root ``Makefile`` drives every shell script under ``scripts/`` through the
``RUN_SHELL_SCRIPT`` variable. On Windows that variable is the Git Bash shim; on
POSIX it used to expand to nothing, so recipes invoked the script directly::

    make: ./scripts/docker.sh: Permission denied
    make: *** [Makefile:181: docker-start] Error 127

Git tracks the executable bit, so a normal ``git clone`` is fine. It is lost in
the working tree whenever the checkout does not carry POSIX modes: source zip or
tarball downloads from the Releases/Code page, ``core.fileMode=false`` clones,
and non-POSIX filesystems (some Windows/WSL and network mounts). Nothing in the
repository can restore the bit for those users.

Naming the interpreter removes the dependency entirely -- ``bash ./x.sh`` ignores
the mode. Every script under ``scripts/`` uses ``#!/usr/bin/env bash``, so a
single ``$(BASH)`` default is correct for all of them, and the Windows branch is
untouched.

This test pins both halves of the invariant: no recipe may invoke a shell script
bare, and the POSIX definition of ``RUN_SHELL_SCRIPT`` must name an interpreter.
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MAKEFILE = REPO_ROOT / "Makefile"

# A recipe line is a tab-indented command, optionally silenced with "@".
_RECIPE_SHELL_SCRIPT = re.compile(r"^\t@?(?P<command>.*\./scripts/[\w.-]+\.sh.*)$")


def _recipe_lines_invoking_shell_scripts() -> list[tuple[int, str]]:
    lines = MAKEFILE.read_text(encoding="utf-8").splitlines()
    found = []
    for number, line in enumerate(lines, start=1):
        match = _RECIPE_SHELL_SCRIPT.match(line)
        if match:
            found.append((number, match.group("command")))
    return found


def test_makefile_never_invokes_shell_scripts_bare() -> None:
    """Every ``scripts/*.sh`` recipe goes through an interpreter variable."""
    invocations = _recipe_lines_invoking_shell_scripts()
    assert invocations, "expected the Makefile to invoke scripts/*.sh somewhere"

    bare = [f"Makefile:{number}: {command}" for number, command in invocations if not command.startswith("$(RUN_SHELL_SCRIPT)")]
    assert not bare, "these recipes invoke a shell script without an interpreter, so they fail with 'Permission denied' in checkouts that lost the executable bit; prefix them with $(RUN_SHELL_SCRIPT):\n  " + "\n  ".join(bare)


def test_posix_run_shell_script_names_an_interpreter() -> None:
    """The non-Windows branch must expand to an interpreter, not to nothing."""
    text = MAKEFILE.read_text(encoding="utf-8")

    assert re.search(r"^BASH \?= bash$", text, re.MULTILINE), "expected 'BASH ?= bash' so operators can override the interpreter"

    assignments = re.findall(r"^\s*RUN_SHELL_SCRIPT\s*=\s*(.*)$", text, re.MULTILINE)
    assert len(assignments) == 2, f"expected one RUN_SHELL_SCRIPT definition per platform branch, got {assignments}"
    windows, posix = assignments
    assert "run-with-git-bash.cmd" in windows, windows
    assert posix.strip() == "$(BASH)", f"the POSIX branch must name an interpreter; an empty value makes recipes depend on the executable bit, got {posix!r}"


SCRIPTS_DIR = REPO_ROOT / "scripts"

# Any reference to a shell script, however the path is spelled: "./scripts/x.sh",
# "$REPO_ROOT/scripts/x.sh", "$SCRIPT_DIR/x.sh".
_SCRIPT_REFERENCE = re.compile(r"\S*[\w.-]+\.sh\b")

# A script name inside a usage string or hint is prose, not an invocation.
_MESSAGE_COMMAND = re.compile(r"\b(echo|printf|cat)\b")

# A sibling script is independent of its executable bit only when an
# interpreter/builtin is the actual shell command.  Text such as
# ``mode=source`` or ``runner-source`` must not earn that exemption.
_INTERPRETED_SCRIPT_COMMAND = re.compile(
    r"(?:^|.*(?:&&|\|\||;)\s*)"
    r"(?:if\s+)?(?:!\s+)?(?:exec\s+)?"
    r"(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*"
    r"(?:bash|source|\.)\s+$"
)


def _is_bare_script_reference(line: str, *, current_script: str) -> bool:
    for match in _SCRIPT_REFERENCE.finditer(line):
        reference = match.group(0)
        before = line[: match.start()]
        if "://" in reference:  # a download URL, not a local script
            continue
        if reference.endswith(current_script):  # usage string / log prefix
            continue
        if _MESSAGE_COMMAND.search(before):  # a hint printed to the user
            continue
        if not _INTERPRETED_SCRIPT_COMMAND.search(before):
            return True
    return False


def _sibling_script_invocations() -> list[tuple[str, int, str]]:
    """Every line in scripts/*.sh that actually runs another shell script."""
    found = []
    for script in sorted(SCRIPTS_DIR.glob("*.sh")):
        for number, raw in enumerate(script.read_text(encoding="utf-8").splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if _is_bare_script_reference(line, current_script=script.name):
                found.append((script.name, number, line))
    return found


def test_interpreter_words_only_exempt_real_shell_command_positions() -> None:
    assert not _is_bare_script_reference('source "$SCRIPT_DIR/child.sh"', current_script="parent.sh")
    assert not _is_bare_script_reference('. "$SCRIPT_DIR/child.sh"', current_script="parent.sh")
    assert not _is_bare_script_reference('mode=dev source "$SCRIPT_DIR/child.sh"', current_script="parent.sh")
    assert _is_bare_script_reference('mode=source "$SCRIPT_DIR/child.sh"', current_script="parent.sh")
    assert _is_bare_script_reference('runner-source "$SCRIPT_DIR/child.sh"', current_script="parent.sh")


def test_scripts_never_invoke_sibling_scripts_bare() -> None:
    """A script calling another script must name the interpreter too.

    ``make docker-stop`` reaches ``scripts/cleanup-containers.sh`` through
    ``scripts/docker.sh``, so fixing only the Makefile would leave the same
    ``Permission denied`` failure one level deeper.
    """
    bare = [f"scripts/{name}:{number}: {line}" for name, number, line in _sibling_script_invocations()]
    assert not bare, "these lines run another shell script without an interpreter, so they fail with 'Permission denied' in checkouts that lost the executable bit; prefix them with 'bash':\n  " + "\n  ".join(bare)
