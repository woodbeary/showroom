import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import holdout  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EXAMPLE = ROOT / "examples" / "experiment"
AS_OF = datetime(2026, 10, 15, tzinfo=UTC)


class Copy:
    def __enter__(self) -> Path:
        self.tmp = Path(tempfile.mkdtemp(prefix="showroom-holdout-"))
        for f in EXAMPLE.iterdir():
            shutil.copy(f, self.tmp / f.name)
        return self.tmp

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.tmp)


class AssignmentTest(unittest.TestCase):
    def test_matches_the_typescript_runtime(self) -> None:
        vectors = json.loads((ROOT / "test" / "vectors" / "assignment.json").read_text())
        for v in vectors:
            arm = holdout.assign_arm(v["leadId"], v["salt"], v["holdoutShare"])
            self.assertEqual(arm, v["arm"], v["leadId"])
            self.assertAlmostEqual(holdout.arm_score(v["leadId"], v["salt"]), v["score"], places=9)

    def test_a_recorded_arm_that_disagrees_with_the_hash_is_refused(self) -> None:
        with Copy() as d:
            lines = (d / "leads.csv").read_text().splitlines()
            i = next(n for n, line in enumerate(lines) if line.endswith(",holdout"))
            lines[i] = lines[i].replace(",holdout", ",agent")
            (d / "leads.csv").write_text("\n".join(lines) + "\n")
            with self.assertRaises(holdout.AssignmentError):
                holdout.run(d, as_of=AS_OF)


class WilsonTest(unittest.TestCase):
    def test_known_values(self) -> None:
        lo, hi = holdout.wilson(9, 10)
        self.assertAlmostEqual(lo, 0.5958, places=3)
        self.assertAlmostEqual(hi, 0.9821, places=3)
        self.assertEqual(holdout.wilson(0, 0), (0.0, 1.0))


class ReadoutTest(unittest.TestCase):
    def test_example_readout(self) -> None:
        r = holdout.run(EXAMPLE, as_of=AS_OF)
        self.assertEqual(r.enrolled, 2000)
        self.assertEqual(r.excluded_before_launch, 40)
        self.assertEqual((r.agent.n, r.agent.sold), (1601, 83))
        self.assertEqual((r.holdout.n, r.holdout.sold), (399, 21))
        self.assertGreater(r.p_value, 0.05)
        self.assertLess(r.interval[0], 0)
        self.assertGreater(r.interval[1], 0)
        self.assertGreater(r.detectable, r.planned_mde)

    def test_sales_outside_the_30_day_window_do_not_count(self) -> None:
        with Copy() as d:
            (d / "leads.csv").write_text(
                "lead_id,created_at,arm\n"
                f"A,2026-07-10T00:00:00Z,{holdout.assign_arm('A', 'pilot-2026-07', 0.2)}\n"
                f"B,2026-07-10T00:00:00Z,{holdout.assign_arm('B', 'pilot-2026-07', 0.2)}\n"
                f"Q,2026-07-10T00:00:00Z,{holdout.assign_arm('Q', 'pilot-2026-07', 0.2)}\n"
            )
            (d / "sales.csv").write_text(
                "deal_id,lead_id,sold_at,system\n"
                "D1,A,2026-08-08T23:59:00Z,dealer_sales_record\n"
                "D2,B,2026-08-09T00:00:01Z,dealer_sales_record\n"
                "D3,Q,2026-07-09T00:00:00Z,dealer_sales_record\n"
            )
            r = holdout.run(d, as_of=AS_OF)
            self.assertEqual(r.agent.sold + r.holdout.sold, 1)


class RefusalTest(unittest.TestCase):
    def test_the_agents_own_booking_log_cannot_feed_the_primary_metric(self) -> None:
        with self.assertRaises(holdout.ProvenanceError):
            holdout.run(EXAMPLE, outcomes=EXAMPLE / "agent-bookings.jsonl", as_of=AS_OF)

    def test_one_agent_written_row_in_the_sales_file_is_refused(self) -> None:
        with Copy() as d:
            with (d / "sales.csv").open("a") as fh:
                fh.write("D99999,X-00002,2026-07-20T00:00:00Z,showroom\n")
            with self.assertRaises(holdout.ProvenanceError):
                holdout.run(d, as_of=AS_OF)

    def test_another_file_than_the_preregistered_source_is_refused(self) -> None:
        with Copy() as d:
            shutil.copy(d / "sales.csv", d / "sales-v2.csv")
            with self.assertRaises(holdout.PreregistrationError):
                holdout.run(d, outcomes=d / "sales-v2.csv", as_of=AS_OF)

    def test_a_preregistration_edited_after_launch_is_refused(self) -> None:
        with Copy() as d:
            prereg = json.loads((d / "preregistration.json").read_text())
            prereg["primaryMetric"]["windowDays"] = 45
            (d / "preregistration.json").write_text(json.dumps(prereg, indent=2) + "\n")
            with self.assertRaises(holdout.PreregistrationError):
                holdout.run(d, as_of=AS_OF)

    def test_no_peeking_before_the_registered_readout_date(self) -> None:
        with self.assertRaises(holdout.PreregistrationError):
            holdout.run(EXAMPLE, as_of=datetime(2026, 9, 1, tzinfo=UTC))

    def test_cli_exits_2_on_a_refusal(self) -> None:
        out = subprocess.run(
            [
                sys.executable,
                str(ROOT / "analysis" / "holdout.py"),
                str(EXAMPLE),
                "--outcomes",
                str(EXAMPLE / "agent-bookings.jsonl"),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(out.returncode, 2)
        self.assertIn("ProvenanceError", out.stderr)


if __name__ == "__main__":
    unittest.main()
