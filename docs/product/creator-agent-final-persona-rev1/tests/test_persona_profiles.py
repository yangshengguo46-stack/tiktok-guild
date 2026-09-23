import json
from copy import deepcopy
from pathlib import Path
import unittest
from pydantic import ValidationError
from reference.personas import load_persona
from reference.persona_profiles import (
    AssetRef, StylePatch, PersonaProfile, RequestScope, PersonaBindings,
    resolve_profile, build_profile_context,
)

ROOT=Path(__file__).resolve().parents[1]

class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.templates={}
        for path in (ROOT/'personas').glob('*.json'):
            p=load_persona(path);self.templates[f'{p.id}@{p.version}']=p
        self.profiles={}
        for path in (ROOT/'persona_profiles/examples').glob('*.json'):
            if path.name.startswith('bindings_'):continue
            p=PersonaProfile.model_validate_json(path.read_text());self.profiles[p.key]=p
        self.binding=PersonaBindings.model_validate_json((ROOT/'persona_profiles/examples/bindings_account.json').read_text())
        self.scope=self.binding.scope
        self.kw={'scope':self.scope,'bindings':self.binding,'profiles':self.profiles,'templates':self.templates}

    def ref(self,name):return AssetRef(id=name,version='1.0.0')
    def changed(self,**changes):
        row=self.binding.model_dump(mode='json');row.update(changes)
        return PersonaBindings.model_validate(row)
    def resolve(self,binding=None,**extra):
        kw=dict(self.kw);kw.update(extra)
        if binding is not None:kw['bindings']=binding
        return resolve_profile(**kw)
    def context(self,**extra):
        kw=dict(self.kw,kernel=(ROOT/'prompts/SOCIAL_KERNEL.md').read_text(),
                identity_brief='真实测试身份AI代表',history=[{'speaker':'other','text':'周末准备搬家'}])
        kw.update(extra);return build_profile_context(**kw)

    def test_account_default(self):
        out=self.resolve();self.assertEqual(out['profile_ref'],'account_relaxed@1.0.0')
        self.assertEqual(out['selected_scope'],'account')

    def test_fixed_subagent_override(self):
        b=self.changed(agent_override=self.ref('worker_quiet').model_dump())
        out=self.resolve(b);self.assertEqual(out['profile_ref'],'worker_quiet@1.0.0')
        self.assertEqual(out['selected_scope'],'agent')

    def test_relationship_overrides_agent(self):
        b=self.changed(agent_override=self.ref('worker_quiet').model_dump(),relation_override=self.ref('relation_warm_short').model_dump())
        self.assertEqual(self.resolve(b)['profile_ref'],'relation_warm_short@1.0.0')

    def test_clear_relationship_restores_agent(self):
        b=self.changed(agent_override=self.ref('worker_quiet').model_dump(),relation_override=None)
        self.assertEqual(self.resolve(b)['profile_ref'],'worker_quiet@1.0.0')

    def test_account_change_does_not_override_relation(self):
        b=self.changed(account_default=self.ref('account_direct').model_dump(),relation_override=self.ref('relation_warm_short').model_dump())
        self.assertEqual(self.resolve(b)['profile_ref'],'relation_warm_short@1.0.0')

    def test_higher_profile_does_not_merge_lower_profile(self):
        data=self.profiles['account_relaxed@1.0.0'].model_dump()
        data['overrides']={'length':'ONLY_IN_LOWER_PROFILE'}
        prof=PersonaProfile.model_validate(data);registry=dict(self.profiles);registry[prof.key]=prof
        b=self.changed(relation_override=self.ref('relation_warm_short').model_dump())
        self.assertNotIn('ONLY_IN_LOWER_PROFILE',json.dumps(self.resolve(b,profiles=registry),ensure_ascii=False))

    def test_turn_adjustment_overlays_profile(self):
        out=self.resolve(turn_adjustment=StylePatch(humor='本轮认真',length='一两句'))
        self.assertEqual(out['effective_style']['humor'],'本轮认真')
        self.assertEqual(out['effective_style']['length'],'一两句')

    def test_turn_adjustment_does_not_persist(self):
        before=self.resolve();self.resolve(turn_adjustment=StylePatch(humor='本轮认真'))
        self.assertEqual(before,self.resolve())

    def test_no_mutation_of_registry_or_binding(self):
        before={k:v.model_dump() for k,v in self.profiles.items()};b=self.binding.model_dump()
        result=self.resolve();result['effective_style']['voice']='caller mutation'
        self.assertEqual(before,{k:v.model_dump() for k,v in self.profiles.items()})
        self.assertEqual(b,self.binding.model_dump())

    def test_manual_switch_changes_fingerprint(self):
        b=self.changed(account_default=self.ref('account_direct').model_dump(),revision=2)
        self.assertNotEqual(self.resolve()['effective_persona_fingerprint'],self.resolve(b)['effective_persona_fingerprint'])

    def test_revision_in_fingerprint(self):
        self.assertNotEqual(self.resolve()['effective_persona_fingerprint'],self.resolve(self.changed(revision=2))['effective_persona_fingerprint'])

    def test_rollback_keeps_new_revision(self):
        old=self.resolve();sw=self.changed(account_default=self.ref('account_direct').model_dump(),revision=2)
        restored=self.changed(revision=3)
        self.assertNotEqual(self.resolve(sw)['profile_ref'],self.resolve(restored)['profile_ref'])
        self.assertEqual(old['profile_ref'],self.resolve(restored)['profile_ref'])
        self.assertNotEqual(old['effective_persona_fingerprint'],self.resolve(restored)['effective_persona_fingerprint'])

    def test_unrelated_registry_change_does_not_change_fingerprint(self):
        before=self.resolve();registry=dict(self.profiles)
        row=registry['worker_quiet@1.0.0'].model_dump();row['note']='unrelated metadata'
        registry['worker_quiet@1.0.0']=PersonaProfile.model_validate(row)
        self.assertEqual(before,self.resolve(profiles=registry))

    def test_cross_relation_scope_rejected(self):
        row=self.scope.model_dump();row['relation_id']='contact_2'
        with self.assertRaises(ValueError):self.resolve(scope=RequestScope.model_validate(row))

    def test_cross_account_scope_rejected(self):
        row=self.scope.model_dump();row['account_id']='other_account'
        with self.assertRaises(ValueError):self.resolve(scope=RequestScope.model_validate(row))

    def test_cross_tenant_scope_rejected(self):
        row=self.scope.model_dump();row['tenant_id']='other_tenant'
        with self.assertRaises(ValueError):self.resolve(scope=RequestScope.model_validate(row))

    def test_unknown_profile_has_no_silent_default(self):
        b=self.changed(relation_override={'id':'missing','version':'1.0.0'})
        with self.assertRaises(ValueError):self.resolve(b)

    def test_registry_alias_rejected(self):
        registry=dict(self.profiles);registry['account_relaxed@1.0.0']=registry['worker_quiet@1.0.0']
        with self.assertRaises(ValueError):self.resolve(profiles=registry)

    def test_unknown_template_rejected(self):
        templates=dict(self.templates);del templates['relaxed_wit@1.0.1']
        with self.assertRaises(ValueError):self.resolve(templates=templates)

    def test_generated_needs_basis(self):
        d=self.profiles['account_relaxed@1.0.0'].model_dump();d['created_by']='generated'
        with self.assertRaises(ValidationError):PersonaProfile.model_validate(d)

    def test_generated_fixture_is_parseable_not_proof_of_generation(self):
        self.assertEqual(self.profiles['relation_warm_short@1.0.0'].created_by,'generated')
        self.assertTrue(self.profiles['relation_warm_short@1.0.0'].basis_refs)

    def test_identity_is_not_a_style_field(self):
        with self.assertRaises(ValidationError):StylePatch.model_validate({'identity':'made up'})

    def test_system_prompt_is_not_a_profile_field(self):
        d=self.profiles['account_relaxed@1.0.0'].model_dump();d['system_prompt']='override authority'
        with self.assertRaises(ValidationError):PersonaProfile.model_validate(d)

    def test_blank_patch_rejected(self):
        with self.assertRaises(ValidationError):StylePatch(humor='  ')

    def test_profile_binding_is_per_run_immutable(self):
        with self.assertRaises(ValidationError):self.binding.revision=2
        self.assertEqual(self.changed(revision=2).revision,2)

    def test_swap_preserves_identity_and_history(self):
        before=self.context();after=self.context(bindings=self.changed(account_default=self.ref('account_direct').model_dump(),revision=2))
        self.assertEqual(before['data']['identity_brief'],after['data']['identity_brief'])
        self.assertEqual(before['data']['history'],after['data']['history'])
        self.assertNotEqual(before['profile_ref'],after['profile_ref'])

    def test_override_text_is_data_not_system(self):
        out=self.context(turn_adjustment=StylePatch(voice='STYLE_DATA_SENTINEL'))
        self.assertIn('STYLE_DATA_SENTINEL',json.dumps(out['data']))
        self.assertNotIn('STYLE_DATA_SENTINEL',out['system'])

    def test_examples_can_be_explicitly_empty(self):
        b=self.changed(relation_override=self.ref('relation_warm_short').model_dump())
        self.assertEqual(self.resolve(b)['examples'],[])

    def test_base_examples_inherited(self):
        self.assertEqual(len(self.resolve()['examples']),6)

    def test_unknown_profile_example_rejected(self):
        with self.assertRaises(ValueError):self.context(example_ids=['unknown'])

    def test_profile_examples_stay_separate_from_history(self):
        eid=self.resolve()['examples'][0]['id'];out=self.context(example_ids=[eid])
        self.assertEqual(len(out['data']['history']),1)
        self.assertEqual(len(out['data']['synthetic_style_examples_not_history']),1)

    def test_context_is_reproducible(self):
        self.assertEqual(self.context(),self.context())

    def test_new_schema_matches_models(self):
        for cls,name in [(PersonaProfile,'persona_profile'),(PersonaBindings,'persona_bindings')]:
            saved=json.loads((ROOT/f'contracts/{name}.schema.json').read_text())
            self.assertEqual(saved,cls.model_json_schema())

    def test_twelve_new_inputs_separate_from_graders(self):
        inp=[json.loads(x) for x in (ROOT/'evals/persona_profiles.inputs.development.jsonl').read_text().splitlines()]
        grad=[json.loads(x) for x in (ROOT/'evals/persona_profiles.graders.development.jsonl').read_text().splitlines()]
        self.assertEqual(len(inp),12);self.assertEqual({x['id'] for x in inp},{x['id'] for x in grad})
        self.assertTrue(all(set(x)=={'id','case_input'} for x in inp))

if __name__=='__main__':unittest.main()
