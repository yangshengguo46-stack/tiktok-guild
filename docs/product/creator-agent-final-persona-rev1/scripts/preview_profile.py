"""Print an offline input preview; does not call any model or send messages."""
from pathlib import Path
import argparse
import json
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from reference.personas import load_persona
from reference.persona_profiles import PersonaProfile, PersonaBindings, build_profile_context

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['account','subagent','relationship','switch','rollback'], default='relationship')
    args = parser.parse_args()
    folder = ROOT / 'persona_profiles/examples'
    profiles = {}
    for path in folder.glob('*.json'):
        if path.name.startswith('bindings_'):continue
        row = PersonaProfile.model_validate_json(path.read_text(encoding='utf-8'))
        profiles[row.key] = row
    templates = {}
    for path in (ROOT/'personas').glob('*.json'):
        row = load_persona(path); templates[f'{row.id}@{row.version}'] = row
    bindings = PersonaBindings.model_validate_json((folder/f'bindings_{args.case}.json').read_text())
    result = build_profile_context(scope=bindings.scope, bindings=bindings, profiles=profiles,
        templates=templates, kernel=(ROOT/'prompts/SOCIAL_KERNEL.md').read_text(),
        identity_brief='仅用于离线预览的AI账号，未绑定生产身份。',
        history=[{'speaker':'other','text':'今天先随便聊点别的吧。'}])
    print(json.dumps({'mode':'offline_preview_not_model_output','case':args.case,'payload':result},ensure_ascii=False,indent=2))

if __name__=='__main__':main()
