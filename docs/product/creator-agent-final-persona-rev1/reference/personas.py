"""Persona and context contracts only. No model, network, sending or DeerFlow runtime.

Character style files here are trusted, operator-reviewed configuration. External
character cards MUST NOT be passed here without review. Text in memories, examples,
world items and role materials remains data. Checks prove structure, not semantics.
"""
from __future__ import annotations
import hashlib
from copy import deepcopy
import json
from pathlib import Path
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator

class DialogueLine(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    speaker: Literal["other", "agent"]
    text: str = Field(min_length=1)

class PersonaExample(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1)
    scene: str = Field(min_length=1)
    messages: list[DialogueLine] = Field(min_length=2)

class PersonaSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    schema_version: Literal["1.0"]
    version: str
    kind: Literal["behavioral_persona_not_identity"]
    identity_policy: str
    stability_policy: str
    truth_policy: str
    non_goals: list[str]
    example_policy: str
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str
    recommendation: str
    core: str
    behavior: dict[str, str]
    interests: list[str]
    failure_modes: list[str]
    adaptation: dict[str, list[str]]
    examples: list[PersonaExample]

    @model_validator(mode="after")
    def distinct(self):
        ids=[x.id for x in self.examples]
        if len(ids)!=len(set(ids)):raise ValueError("duplicate example IDs")
        for value in [self.version,self.core,self.display_name,*self.behavior.values()]:
            if not value.strip():raise ValueError("blank persona fields")
        return self

class PersonaBinding(BaseModel):
    """Resolved per-run template reference; not an immutable lifetime binding."""
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    agent_instance_id: str
    persona_id: str
    persona_version: str

class ScopedMaterial(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str
    kind: Literal["relation", "world", "role", "expression"]
    text: str
    source_ref: str = Field(min_length=1)
    agent_instance_id: str
    relation_id: str | None = None

    @model_validator(mode="after")
    def source_and_scope(self):
        if not self.source_ref.strip():raise ValueError("missing source")
        if self.kind=="relation" and not self.relation_id:raise ValueError("relation memory needs its scope")
        return self

def load_persona(path: str | Path) -> PersonaSpec:
    return PersonaSpec.model_validate_json(Path(path).read_text(encoding="utf-8"))

def build_context(*, kernel: str, persona: PersonaSpec, binding: PersonaBinding,
                  relation_id: str, identity_brief: str, history: list[dict],
                  materials: list[ScopedMaterial] | None=None,
                  example_ids: list[str] | None=None,
                  recipient_preferences: str="") -> dict:
    """Build a reproducible prompt/data envelope; NOT a semantic business router.

    Host retrieves relevant materials using its existing context/tools. A role
    fact not in this call stays available via tools; this is not a sales gate.
    Host MUST scope history before calling. No fake fallback personality.
    """
    if (binding.persona_id,binding.persona_version)!=(persona.id,persona.version):
        raise ValueError("persona binding mismatch")
    if not relation_id.strip() or not identity_brief.strip():raise ValueError("missing relation/identity")
    chosen=example_ids or []
    if len(chosen)!=len(set(chosen)):raise ValueError("duplicate requested examples")
    all_examples={x.id:x for x in persona.examples}
    if any(x not in all_examples for x in chosen):raise ValueError("unknown example")
    selected=[]
    for m in materials or []:
        if m.agent_instance_id!=binding.agent_instance_id:raise ValueError("cross-agent material")
        if m.relation_id is not None and m.relation_id!=relation_id:raise ValueError("cross-relation material")
        selected.append(m.model_dump(mode="json"))
    # Trusted style only; all user/model/source content goes to data, not system.
    style={"name":persona.display_name,"core":persona.core,"behavior":persona.behavior,
           "interests_are_attention_not_experiences":persona.interests,
           "identity_policy":persona.identity_policy,"truth_policy":persona.truth_policy,
           "failure_modes":persona.failure_modes,"adaptation":persona.adaptation}
    system=kernel+"\n\n本轮基础表达配置（不是身份、事实或授权；若数据有effective_persona_style，只在风格范围采用其合成结果）：\n"+json.dumps(style,ensure_ascii=False)
    data={"identity_brief":identity_brief,"history":deepcopy(history),"materials":selected,
          "recipient_preferences_as_data":recipient_preferences,
          "synthetic_style_examples_not_history":[all_examples[x].model_dump(mode="json") for x in chosen]}
    payload={"binding":binding.model_dump(),"relation_id":relation_id,"system":system,"data":data}
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()
    return {"system":system,"data":data,"context_fingerprint":digest,
            "persona_ref":f"{persona.id}@{persona.version}"}
