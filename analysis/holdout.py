"""Holdout readout for a pre-registered experiment.

Reads the primary metric only from the system named in the pre-registration, refuses any
row an agent system wrote, re-derives every lead's arm from its id, and refuses to run if
the pre-registration changed after launch or the readout date hasn't come yet.

    python3 analysis/holdout.py examples/experiment
    python3 analysis/holdout.py examples/experiment --outcomes examples/experiment/agent-bookings.jsonl

Exit 0 with a readout, 2 when it refuses. Standard library only.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import NormalDist


class Refused(Exception):
    """The readout would not be trustworthy, so it doesn't run."""


class PreregistrationError(Refused):
    pass


class ProvenanceError(Refused):
    pass


class AssignmentError(Refused):
    pass


def parse_ts(value: str, field: str) -> datetime:
    try:
        ts = datetime.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise Refused(f"{field} {value!r} is not an ISO 8601 time") from exc
    if ts.tzinfo is None:
        raise Refused(f"{field} {value!r} has no timezone")
    return ts


def arm_score(lead_id: str, salt: str) -> float:
    digest = hashlib.sha256(f"{salt}:{lead_id}".encode()).digest()
    return int.from_bytes(digest[:4], "big") / 2**32


def assign_arm(lead_id: str, salt: str, holdout_share: float) -> str:
    if not 0 < holdout_share < 1:
        raise ValueError(f"holdout_share must be between 0 and 1, got {holdout_share}")
    return "holdout" if arm_score(lead_id, salt) < holdout_share else "agent"


def wilson(k: int, n: int, confidence: float = 0.95) -> tuple[float, float]:
    if n == 0:
        return (0.0, 1.0)
    z = NormalDist().inv_cdf(1 - (1 - confidence) / 2)
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (max(0.0, center - half), min(1.0, center + half))


def load_preregistration(folder: Path) -> tuple[dict, str]:
    prereg_path = folder / "preregistration.json"
    launch_path = folder / "launch.json"
    if not launch_path.exists():
        raise PreregistrationError(f"{launch_path} is missing: no launch record, no readout")
    raw = prereg_path.read_bytes()
    prereg = json.loads(raw)
    launch = json.loads(launch_path.read_text())
    sha = hashlib.sha256(raw).hexdigest()
    if launch["preregistration"]["sha256"] != sha:
        raise PreregistrationError(
            f"{prereg_path.name} changed after launch: sha256 {sha[:12]} != "
            f"{launch['preregistration']['sha256'][:12]} recorded at launch"
        )
    registered = parse_ts(prereg["registeredAt"], "registeredAt")
    launched = parse_ts(launch["launchedAt"], "launchedAt")
    if registered >= launched:
        raise PreregistrationError(
            f"registered {prereg['registeredAt']} is not before launch {launch['launchedAt']}"
        )
    if parse_ts(prereg["launchAt"], "launchAt") != launched:
        raise PreregistrationError("launchAt in the pre-registration differs from the launch record")
    return prereg, sha


def read_rows(path: Path) -> list[dict]:
    if path.suffix == ".csv":
        with path.open(newline="") as fh:
            return list(csv.DictReader(fh))
    if path.suffix == ".jsonl":
        return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    raise Refused(f"{path}: outcomes must be .csv or .jsonl")


def read_outcomes(path: Path, prereg: dict) -> list[tuple[str, datetime]]:
    source = prereg["primaryMetric"]["source"]
    agent_systems = set(prereg.get("agentSystems", []))
    if source["system"] in agent_systems:
        raise ProvenanceError(f"the primary metric's source {source['system']} is an agent system")
    rows = read_rows(path)
    out: list[tuple[str, datetime]] = []
    for n, row in enumerate(rows, start=1):
        system = row.get("system") or row.get("writtenBy")
        if system in agent_systems:
            raise ProvenanceError(
                f"{path.name} row {n} was written by {system}, an agent system; the primary "
                f"metric reads only {source['system']}"
            )
        if system != source["system"]:
            raise ProvenanceError(
                f"{path.name} row {n} comes from {system!r}, not the pre-registered "
                f"{source['system']}"
            )
        if row.get("lead_id"):
            out.append((row["lead_id"], parse_ts(row["sold_at"], f"{path.name} row {n} sold_at")))
    if path.name != source["path"]:
        raise PreregistrationError(
            f"the pre-registration names {source['path']} as the outcome source, not {path.name}"
        )
    return out


@dataclass(frozen=True)
class Arm:
    name: str
    n: int
    sold: int

    @property
    def rate(self) -> float:
        return self.sold / self.n if self.n else 0.0


@dataclass(frozen=True)
class Readout:
    experiment: str
    sha: str
    enrolled: int
    excluded_before_launch: int
    agent: Arm
    holdout: Arm
    difference: float
    interval: tuple[float, float]
    p_value: float
    detectable: float
    alpha: float
    planned_mde: float
    metric: str
    source: str


def run(folder: Path, outcomes: Path | None = None, as_of: datetime | None = None) -> Readout:
    prereg, sha = load_preregistration(folder)
    as_of = as_of or datetime.now(UTC)
    not_before = parse_ts(prereg["readoutNotBefore"], "readoutNotBefore")
    if as_of < not_before:
        raise PreregistrationError(
            f"the readout is pre-registered for {prereg['readoutNotBefore']}; no peeking before then"
        )
    sales = read_outcomes(outcomes or folder / prereg["primaryMetric"]["source"]["path"], prereg)
    by_lead: dict[str, list[datetime]] = {}
    for lead_id, sold_at in sales:
        by_lead.setdefault(lead_id, []).append(sold_at)

    a = prereg["assignment"]
    launch = parse_ts(prereg["launchAt"], "launchAt")
    enroll_until = parse_ts(prereg["enrollUntil"], "enrollUntil")
    window = timedelta(days=prereg["primaryMetric"]["windowDays"])
    counts = {"agent": [0, 0], "holdout": [0, 0]}
    before = 0
    with (folder / "leads.csv").open(newline="") as fh:
        for row in csv.DictReader(fh):
            created = parse_ts(row["created_at"], f"lead {row['lead_id']} created_at")
            if created < launch or created >= enroll_until:
                before += 1
                continue
            arm = assign_arm(row["lead_id"], a["salt"], a["holdoutShare"])
            if row["arm"] != arm:
                raise AssignmentError(
                    f"lead {row['lead_id']} is recorded in {row['arm']!r} but its id hashes to "
                    f"{arm!r}; the runtime and the readout disagree on assignment"
                )
            if created + window > as_of:
                raise PreregistrationError(f"lead {row['lead_id']}'s 30-day window is still open")
            sold = any(created <= t < created + window for t in by_lead.get(row["lead_id"], []))
            counts[arm][0] += 1
            counts[arm][1] += int(sold)

    agent = Arm("agent", *counts["agent"])
    holdout = Arm("holdout", *counts["holdout"])
    if agent.n == 0 or holdout.n == 0:
        raise Refused("an arm has no enrolled leads")
    test = prereg["test"]
    alpha = test["alpha"]
    z_alpha = NormalDist().inv_cdf(1 - alpha / 2)
    z_power = NormalDist().inv_cdf(test["power"])
    diff = agent.rate - holdout.rate
    l1, u1 = wilson(agent.sold, agent.n, 1 - alpha)
    l2, u2 = wilson(holdout.sold, holdout.n, 1 - alpha)
    low = diff - math.sqrt((agent.rate - l1) ** 2 + (u2 - holdout.rate) ** 2)
    high = diff + math.sqrt((u1 - agent.rate) ** 2 + (holdout.rate - l2) ** 2)
    pooled = (agent.sold + holdout.sold) / (agent.n + holdout.n)
    se = math.sqrt(pooled * (1 - pooled) * (1 / agent.n + 1 / holdout.n))
    p_value = 2 * (1 - NormalDist().cdf(abs(diff) / se)) if se > 0 else 1.0
    return Readout(
        experiment=prereg["experiment"],
        sha=sha,
        enrolled=agent.n + holdout.n,
        excluded_before_launch=before,
        agent=agent,
        holdout=holdout,
        difference=diff,
        interval=(low, high),
        p_value=p_value,
        detectable=(z_alpha + z_power) * se,
        alpha=alpha,
        planned_mde=test["minimumDetectableEffect"],
        metric=prereg["primaryMetric"]["name"],
        source=f"{prereg['primaryMetric']['source']['path']} "
        f"({prereg['primaryMetric']['source']['system']})",
    )


def pct(x: float) -> str:
    return f"{100 * x:.2f}%"


def points(x: float) -> str:
    return f"{100 * x:+.2f}"


def format_readout(r: Readout) -> str:
    lines = [
        f"{r.experiment}: pre-registration unchanged since launch (sha256 {r.sha[:12]}).",
        f"Primary metric {r.metric}, read from {r.source}.",
        f"{r.enrolled} leads enrolled; arms re-derived from lead_id, all match. "
        f"{r.excluded_before_launch} leads outside the enrollment window left out.",
    ]
    for arm in (r.agent, r.holdout):
        lo, hi = wilson(arm.sold, arm.n, 1 - r.alpha)
        lines.append(
            f"  {arm.name:8} {arm.n:5} leads  {arm.sold:4} sold  {pct(arm.rate):>7}  "
            f"[{pct(lo)}, {pct(hi)}]"
        )
    lo, hi = r.interval
    lines.append(
        f"  difference {points(r.difference)} points, {1 - r.alpha:.0%} CI "
        f"[{points(lo)}, {points(hi)}], two-sided p = {r.p_value:.2f}"
    )
    lines.append(
        f"  At these sizes the smallest difference this test reliably sees is about "
        f"{100 * r.detectable:.1f} points; the pre-registration planned for "
        f"{100 * r.planned_mde:.1f}."
    )
    verdict = (
        "difference detected"
        if r.p_value < r.alpha
        else f"no difference detected at alpha {r.alpha}"
    )
    if r.detectable > r.planned_mde:
        verdict += "; underpowered for the planned effect"
    lines.append(f"Result: {verdict}.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("folder", type=Path)
    ap.add_argument("--outcomes", type=Path, help="override the pre-registered outcome file")
    ap.add_argument("--as-of", help="ISO time of the readout (default: now)")
    args = ap.parse_args(argv)
    try:
        as_of = parse_ts(args.as_of, "--as-of") if args.as_of else None
        print(format_readout(run(args.folder, args.outcomes, as_of)))
    except Refused as exc:
        print(f"refused ({type(exc).__name__}): {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
