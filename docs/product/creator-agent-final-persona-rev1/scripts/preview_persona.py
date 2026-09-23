"""Offline prompt preview only. No model/API calls and no message delivery."""
from pathlib import Path
import argparse, json, sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from reference.personas import load_persona, PersonaBinding, build_context

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--persona",default="relaxed_wit",choices=[p.stem for p in (ROOT/"personas").glob("*.json")])
    parser.add_argument("--examples",action="store_true",help="include the first synthetic style example")
    args=parser.parse_args()
    persona=load_persona(ROOT/"personas"/(args.persona+".json"))
    result=build_context(kernel=(ROOT/"prompts/SOCIAL_KERNEL.md").read_text(),persona=persona,
          binding=PersonaBinding(agent_instance_id="preview-only",persona_id=persona.id,persona_version=persona.version),
          relation_id="preview-only",identity_brief="演练用的机构AI数字经纪人；未绑定任何生产账号。",
          history=[{"speaker":"other","text":"今天什么也不想干，就想随便聊聊。"}],
          example_ids=[persona.examples[0].id] if args.examples else [])
    print(json.dumps({"mode":"offline_preview_not_model_output","payload":result},ensure_ascii=False,indent=2))
if __name__=="__main__":main()
