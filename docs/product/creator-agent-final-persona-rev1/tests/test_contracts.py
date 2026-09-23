import unittest
from pydantic import ValidationError
from reference.contracts import TurnResult, apply_delta, project_outbound, check_send_context


def patch(**overrides):
    result = dict(op="assert", claim_id="c1", text="对方不喜欢催票主导的PK",
                  kind="reported", facet="tradeoff", evidence_ids=["m2"])
    result.update(overrides)
    return result


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {"version": 3, "claims": {}}
        self.evidence = {"m1": "message", "m2": "message", "t1": "tool_observation"}

    def test_normal_reply(self):
        turn = TurnResult(reply="懂了，你烦的是一直催票。")
        self.assertEqual(project_outbound(turn), "懂了，你烦的是一直催票。")

    def test_empty_state_delta_is_valid(self):
        turn = TurnResult(reply="哈哈")
        self.assertEqual(apply_delta(self.snapshot, turn, expected_version=3, evidence_kinds=self.evidence), self.snapshot)

    def test_wait_has_no_message(self):
        self.assertIsNone(project_outbound(TurnResult(reply=None)))

    def test_blank_reply_is_not_a_wait(self):
        with self.assertRaises(ValidationError):
            TurnResult(reply="   ")

    def test_model_cannot_set_destination(self):
        with self.assertRaises(ValidationError):
            TurnResult(reply="你好", account_id="other-account")

    def test_internal_note_not_projected(self):
        turn = TurnResult(reply="几点方便？", decision_note="内部判断，不得外发")
        self.assertNotIn("内部", project_outbound(turn))

    def test_new_claim_has_scoped_evidence(self):
        result = apply_delta(self.snapshot, TurnResult(reply="懂了", state_delta=[patch()]),
                             expected_version=3, evidence_kinds=self.evidence)
        self.assertEqual(result["claims"]["c1"]["kind"], "reported")
        self.assertEqual(result["version"], 4)
        self.assertEqual(self.snapshot["claims"], {})

    def test_foreign_or_missing_evidence_rejected(self):
        with self.assertRaises(ValueError):
            apply_delta(self.snapshot, TurnResult(reply="好", state_delta=[patch(evidence_ids=["other-person-m1"])]),
                        expected_version=3, evidence_kinds=self.evidence)

    def test_report_is_not_tool_observation(self):
        with self.assertRaises(ValueError):
            apply_delta(self.snapshot, TurnResult(reply="好", state_delta=[patch(kind="observed")]),
                        expected_version=3, evidence_kinds=self.evidence)

    def test_tool_observation_has_real_source_type(self):
        result = apply_delta(self.snapshot, TurnResult(reply="查到了", state_delta=[patch(kind="observed", evidence_ids=["t1"])]),
                             expected_version=3, evidence_kinds=self.evidence)
        self.assertEqual(result["claims"]["c1"]["status"], "active")

    def test_retraction_keeps_history(self):
        initial = {"version":3, "claims":{"old":{"text":"不愿任何PK", "kind":"hypothesis", "status":"active"}}}
        turn = TurnResult(reply="刚才我理解宽了", state_delta=[dict(op="retract", claim_id="old", evidence_ids=["m2"]), patch()])
        result = apply_delta(initial, turn, expected_version=3, evidence_kinds=self.evidence)
        self.assertEqual(result["claims"]["old"]["status"], "retracted")
        self.assertEqual(initial["claims"]["old"]["status"], "active")

    def test_reuse_id_rejected_atomically(self):
        initial = {"version":3, "claims":{"c1":{"status":"active"}}}
        with self.assertRaises(ValueError):
            apply_delta(initial, TurnResult(reply="好", state_delta=[patch(claim_id="new"), patch()]),
                        expected_version=3, evidence_kinds=self.evidence)
        self.assertNotIn("new", initial["claims"])

    def test_duplicate_ops_rejected(self):
        with self.assertRaises(ValidationError):
            TurnResult(reply="好", state_delta=[patch(), patch()])

    def test_stale_snapshot_rejected(self):
        with self.assertRaises(ValueError):
            apply_delta(self.snapshot, TurnResult(reply="好"), expected_version=2, evidence_kinds=self.evidence)

    def test_unknown_claim_cannot_be_retracted(self):
        with self.assertRaises(ValueError):
            apply_delta(self.snapshot, TurnResult(reply=None, state_delta=[dict(op="retract",claim_id="absent",evidence_ids=["m2"])]),
                        expected_version=3,evidence_kinds=self.evidence)

    def test_naive_followup_time_rejected(self):
        with self.assertRaises(ValidationError):
            TurnResult(reply=None, followup={"check":"检查复盘交付","not_before":"2026-09-25T10:00:00","cancel_when":"已完成"})

    def test_zoned_followup_time_accepted(self):
        turn = TurnResult(reply=None, followup={"check":"检查复盘交付","not_before":"2026-09-25T10:00:00+09:00","cancel_when":"已完成"})
        self.assertIsNotNone(turn.followup)

    def test_new_message_invalidates_send(self):
        with self.assertRaises(ValueError):
            check_send_context(planned_version=3,current_version=3,planned_event="m1",current_event="m2",human_takeover=False)

    def test_takeover_invalidates_send(self):
        with self.assertRaises(ValueError):
            check_send_context(planned_version=3,current_version=3,planned_event="m1",current_event="m1",human_takeover=True)

    def test_current_context_passes(self):
        check_send_context(planned_version=3,current_version=3,planned_event="m1",current_event="m1",human_takeover=False)


if __name__ == "__main__":
    unittest.main()
