import json
import unittest
from copy import deepcopy
from pydantic import ValidationError
from reference.candidates import (
    Candidate, CandidateSet, ConversationBrief, fingerprint,
    build_rank_request, parse_rank_response, advisory_for_lead,
)
from reference.contracts import TurnResult


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.context = {"relation_id": "r1", "latest_event_id": "m2", "version": 4,
                        "history": [{"id": "m1", "text": "这首歌好难"}, {"id": "m2", "text": "刚才差点破音😂"}]}
        self.pool = CandidateSet(context_fingerprint=fingerprint(self.context), candidates=[
            Candidate(id="c1", move="分享轻松看法", turn=TurnResult(reply="这首直接成极限挑战了😂", decision_note="内部理由")),
            Candidate(id="c2", move="此刻不再发", turn=TurnResult(reply=None)),
        ])
        self.response = {"answers": {"candidate_fit": {"choice": "c1", "probabilities": {
            "c1": .6, "c2": .2, "all_unsuitable": .1, "undetermined": .1}}}}

    def test_empty_brief_allowed(self):
        self.assertIsNone(ConversationBrief().business_relevance)

    def test_single_candidate_not_padded(self):
        pool = CandidateSet(context_fingerprint=fingerprint(self.context), candidates=[self.pool.candidates[0]])
        self.assertEqual(len(pool.candidates), 1)

    def test_empty_candidates_rejected(self):
        with self.assertRaises(ValidationError):
            CandidateSet(context_fingerprint=fingerprint(self.context), candidates=[])

    def test_duplicate_ids_rejected(self):
        with self.assertRaises(ValidationError):
            CandidateSet(context_fingerprint=fingerprint(self.context), candidates=[self.pool.candidates[0], self.pool.candidates[0]])

    def test_exact_duplicate_reply_rejected(self):
        with self.assertRaises(ValidationError):
            CandidateSet(context_fingerprint=fingerprint(self.context), candidates=[self.pool.candidates[0],
                Candidate(id="c3", move="换标签不是换回复", turn=TurnResult(reply=self.pool.candidates[0].turn.reply))])

    def test_no_message_is_real_option(self):
        request = build_rank_request(self.pool, self.context, model="test-not-a-live-model")
        self.assertTrue(json.loads(request["questions"]["candidate_fit"]["criteria"]["c2"])["no_message"])

    def test_all_unsuitable_and_unknown_available(self):
        keys = build_rank_request(self.pool, self.context, model="test-not-a-live-model")["questions"]["candidate_fit"]["criteria"]
        self.assertIn("all_unsuitable", keys)
        self.assertIn("undetermined", keys)

    def test_prompt_preserves_history(self):
        request = build_rank_request(self.pool, self.context, model="test-not-a-live-model")
        self.assertEqual(request["state"]["context"], self.context)

    def test_request_context_does_not_alias_original(self):
        request = build_rank_request(self.pool, self.context, model="test-not-a-live-model")
        request["state"]["context"]["history"].clear()
        self.assertEqual(len(self.context["history"]), 2)

    def test_judge_cannot_read_candidate_self_justification(self):
        text = json.dumps(build_rank_request(self.pool, self.context, model="test-not-a-live-model"), ensure_ascii=False)
        self.assertNotIn("内部理由", text)
        self.assertNotIn("分享轻松看法", text)

    def test_permutation_keeps_stable_ids(self):
        first = build_rank_request(self.pool, self.context, model="test-not-a-live-model", seed=2)
        second = build_rank_request(self.pool, self.context, model="test-not-a-live-model", seed=3)
        a=first["questions"]["candidate_fit"]["criteria"]
        b=second["questions"]["candidate_fit"]["criteria"]
        self.assertEqual(a, b)
        self.assertNotEqual(list(a), list(b))

    def test_stale_source_context_rejected(self):
        context = deepcopy(self.context); context["latest_event_id"] = "m3"
        with self.assertRaises(ValueError):
            build_rank_request(self.pool, context, model="test-not-a-live-model")

    def test_missing_answer_not_success(self):
        with self.assertRaises(ValueError): parse_rank_response(self.pool, {})

    def test_missing_probabilities_not_zero_filled(self):
        response = deepcopy(self.response)
        del response["answers"]["candidate_fit"]["probabilities"]["c2"]
        with self.assertRaises(ValueError): parse_rank_response(self.pool, response)

    def test_unknown_selection_rejected(self):
        response = deepcopy(self.response); response["answers"]["candidate_fit"]["choice"] = "c99"
        with self.assertRaises(ValueError): parse_rank_response(self.pool, response)

    def test_nonfinite_probability_rejected(self):
        response = deepcopy(self.response); response["answers"]["candidate_fit"]["probabilities"]["c1"] = float("nan")
        with self.assertRaises(ValidationError): parse_rank_response(self.pool, response)

    def test_probabilities_not_normalized_silently(self):
        response = deepcopy(self.response); response["answers"]["candidate_fit"]["probabilities"]["c1"] = .2
        with self.assertRaises(ValidationError): parse_rank_response(self.pool, response)

    def test_off_does_not_influence_lead(self):
        self.assertIsNone(advisory_for_lead(self.pool, parse_rank_response(self.pool, self.response), mode="off"))

    def test_shadow_does_not_influence_lead(self):
        self.assertIsNone(advisory_for_lead(self.pool, parse_rank_response(self.pool, self.response), mode="shadow"))

    def test_advisory_is_not_outbound_or_authorization(self):
        result = advisory_for_lead(self.pool, parse_rank_response(self.pool, self.response), mode="advisory")
        self.assertEqual(result["selection"], "c1")
        self.assertNotIn("reply", result)
        self.assertNotIn("send", result)

    def test_changed_candidates_invalidate_signal(self):
        signal = parse_rank_response(self.pool, self.response)
        changed = self.pool.model_copy(deep=True)
        changed.candidates[0].turn.reply = "另一条回复"
        with self.assertRaises(ValueError): advisory_for_lead(changed, signal, mode="advisory")

    def test_all_unsuitable_not_misread_as_silence(self):
        response = deepcopy(self.response)
        response["answers"]["candidate_fit"]["choice"] = "all_unsuitable"
        response["answers"]["candidate_fit"]["probabilities"] = {"c1": .1, "c2": .1, "all_unsuitable": .7, "undetermined": .1}
        result=advisory_for_lead(self.pool, parse_rank_response(self.pool, response), mode="advisory")
        self.assertEqual(result["selection"], "all_unsuitable")
        self.assertNotIn("reply", result)


if __name__ == "__main__":
    unittest.main()
