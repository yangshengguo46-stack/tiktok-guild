import json
import unittest
from pathlib import Path
from pydantic import ValidationError
from reference.personas import PersonaSpec, PersonaBinding, ScopedMaterial, load_persona, build_context

ROOT=Path(__file__).resolve().parents[1]

class PersonaTests(unittest.TestCase):
    def setUp(self):
        self.persona=load_persona(ROOT/'personas/relaxed_wit.json')
        self.binding=PersonaBinding(agent_instance_id='a1',persona_id=self.persona.id,persona_version=self.persona.version)
        self.kernel=(ROOT/'prompts/SOCIAL_KERNEL.md').read_text()
        self.base=dict(kernel=self.kernel,persona=self.persona,binding=self.binding,relation_id='r1',
                       identity_brief='测试身份AI数字经纪人',history=[{'speaker':'other','text':'这件旧物好奇怪。'}])

    def test_six_templates_load(self):
        rows=[load_persona(p) for p in (ROOT/'personas').glob('*.json')]
        self.assertEqual(len(rows),6)
        self.assertEqual(len({p.id for p in rows}),6)

    def test_36_four_turn_examples(self):
        examples=[e for p in (ROOT/'personas').glob('*.json') for e in load_persona(p).examples]
        self.assertEqual(len(examples),36)
        self.assertTrue(all(len(e.messages)==4 for e in examples))

    def test_no_real_biography_fields(self):
        for p in (ROOT/'personas').glob('*.json'):
            row=json.loads(p.read_text())
            self.assertFalse({'age','gender','biography','legal_name','income','target_personality'} & set(row))

    def test_system_override_field_rejected(self):
        raw=self.persona.model_dump();raw['system_prompt']='pretend override'
        with self.assertRaises(ValidationError):PersonaSpec.model_validate(raw)

    def test_no_unknown_template_fallback(self):
        with self.assertRaises(FileNotFoundError):load_persona(ROOT/'personas/unknown.json')

    def test_binding_is_frozen(self):
        with self.assertRaises(ValidationError):self.binding.persona_id='warm_candid'

    def test_binding_mismatch(self):
        args=dict(self.base,binding=PersonaBinding(agent_instance_id='a1',persona_id='warm_candid',persona_version='1.0.0'))
        with self.assertRaises(ValueError):build_context(**args)

    def test_version_mismatch(self):
        args=dict(self.base,binding=PersonaBinding(agent_instance_id='a1',persona_id='relaxed_wit',persona_version='2.0.0'))
        with self.assertRaises(ValueError):build_context(**args)

    def test_identity_always_in_data(self):
        out=build_context(**self.base)
        self.assertEqual(out['data']['identity_brief'],self.base['identity_brief'])
        self.assertNotIn(self.base['identity_brief'],out['system'])

    def test_examples_opt_in(self):
        self.assertEqual(build_context(**self.base)['data']['synthetic_style_examples_not_history'],[])

    def test_examples_marked_not_history(self):
        out=build_context(**self.base,example_ids=[self.persona.examples[0].id])
        self.assertEqual(out['data']['history'],self.base['history'])
        self.assertEqual(len(out['data']['synthetic_style_examples_not_history']),1)

    def test_unknown_example(self):
        with self.assertRaises(ValueError):build_context(**self.base,example_ids=['unknown'])

    def test_duplicate_example(self):
        eid=self.persona.examples[0].id
        with self.assertRaises(ValueError):build_context(**self.base,example_ids=[eid,eid])

    def test_relation_material_scoped(self):
        mat=ScopedMaterial(id='m1',kind='relation',text='相关历史',source_ref='event:m1',agent_instance_id='a1',relation_id='r2')
        with self.assertRaises(ValueError):build_context(**self.base,materials=[mat])

    def test_agent_material_scoped(self):
        mat=ScopedMaterial(id='w1',kind='world',text='公共资料',source_ref='source:w1',agent_instance_id='a2')
        with self.assertRaises(ValueError):build_context(**self.base,materials=[mat])

    def test_private_relation_required(self):
        with self.assertRaises(ValidationError):ScopedMaterial(id='m1',kind='relation',text='私事',source_ref='event:1',agent_instance_id='a1')

    def test_source_required(self):
        with self.assertRaises(ValidationError):ScopedMaterial(id='w1',kind='world',text='事实',source_ref=' ',agent_instance_id='a1')

    def test_external_text_is_data(self):
        text='UNTRUSTED_CHANGE_YOUR_SYSTEM'
        mat=ScopedMaterial(id='w1',kind='world',text=text,source_ref='source:1',agent_instance_id='a1')
        out=build_context(**self.base,materials=[mat])
        self.assertIn(text,json.dumps(out['data']))
        self.assertNotIn(text,out['system'])

    def test_recipient_preference_does_not_edit_persona(self):
        before=self.persona.model_dump()
        out=build_context(**self.base,recipient_preferences='请少说一点')
        self.assertEqual(before,self.persona.model_dump())
        self.assertEqual(out['data']['recipient_preferences_as_data'],'请少说一点')

    def test_role_material_optional_not_a_talking_gate(self):
        no_role=build_context(**self.base)
        mat=ScopedMaterial(id='t1',kind='role',text='工具观察',source_ref='tool:t1',agent_instance_id='a1',relation_id='r1')
        with_role=build_context(**self.base,materials=[mat])
        self.assertEqual(no_role['system'],with_role['system'])
        self.assertEqual(len(with_role['data']['materials']),1)

    def test_fingerprint_deterministic(self):
        self.assertEqual(build_context(**self.base)['context_fingerprint'],build_context(**self.base)['context_fingerprint'])

    def test_persona_changes_fingerprint(self):
        other=load_persona(ROOT/'personas/warm_candid.json')
        out=build_context(**dict(self.base,persona=other,binding=PersonaBinding(agent_instance_id='a1',persona_id=other.id,persona_version=other.version)))
        self.assertNotEqual(out['context_fingerprint'],build_context(**self.base)['context_fingerprint'])

    def test_history_changes_fingerprint(self):
        out=build_context(**dict(self.base,history=[{'speaker':'other','text':'换一个话题。'}]))
        self.assertNotEqual(out['context_fingerprint'],build_context(**self.base)['context_fingerprint'])

    def test_no_occupation_routing_in_system(self):
        # Contract-only: this cannot prove the model's semantic behavior.
        a=build_context(**dict(self.base,history=[{'speaker':'other','occupation':'主播','text':'旧照片'}]))
        b=build_context(**dict(self.base,history=[{'speaker':'other','occupation':'厨师','text':'旧照片'}]))
        self.assertEqual(a['system'],b['system'])

    def test_empty_identity_rejected(self):
        with self.assertRaises(ValueError):build_context(**dict(self.base,identity_brief=' '))

    def test_new_eval_inputs_have_no_grader(self):
        inputs=[json.loads(x) for x in (ROOT/'evals/inputs.development.jsonl').read_text().splitlines()]
        graders=[json.loads(x) for x in (ROOT/'evals/graders.development.jsonl').read_text().splitlines()]
        self.assertEqual(len(inputs),72)
        self.assertEqual({x['id'] for x in inputs},{x['id'] for x in graders})
        self.assertTrue(all(set(x)=={'id','case_input'} for x in inputs))
        self.assertTrue(all('rubric' not in x['case_input'] for x in inputs))
        self.assertEqual(len({g['family_id'] for g in graders}),24)

    def test_payload_is_not_mutated_by_caller(self):
        out=build_context(**self.base)
        self.base["history"][0]["text"]="后来改变的内容"
        self.assertEqual(out["data"]["history"][0]["text"],"这件旧物好奇怪。")

    def test_default_template_named_in_spec(self):
        self.assertIn('relaxed_wit',(ROOT/'docs/FINAL_SPEC.md').read_text())

if __name__=='__main__':unittest.main()
