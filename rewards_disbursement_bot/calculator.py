from decimal import Decimal, getcontext, ROUND_DOWN
from typing import Dict, List, Any


# Increase precision to handle large share numbers safely.
getcontext().prec = 50


DAILY_REWARD_PER_POOL = Decimal("4000")
HOURLY_REWARD_PER_POOL = DAILY_REWARD_PER_POOL / Decimal("24")


def compute_percentages_and_hourly(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    total_shares = Decimal(str(snapshot["total_shares"]))
    outputs: List[Dict[str, Any]] = []

    for rec in snapshot["records"]:
        balance = Decimal(str(rec["balance"]))
        percent = (balance / total_shares) if total_shares > 0 else Decimal("0")
        hourly = (HOURLY_REWARD_PER_POOL * percent).quantize(Decimal("0.0000001"), rounding=ROUND_DOWN)
        outputs.append(
            {
                "account": rec["account"],
                "balance": str(balance),
                "percent": str((percent * Decimal("100")).quantize(Decimal("0.0000001"), rounding=ROUND_DOWN)),
                "hourly_amount_lmnr": str(hourly),
            }
        )

    return outputs


