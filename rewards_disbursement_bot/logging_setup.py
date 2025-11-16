import logging
import sys


def setup_logging(level: int = logging.INFO) -> None:
    formatter = logging.Formatter(
        fmt="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%SZ",
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(level)
    if not any(isinstance(h, logging.StreamHandler) for h in root.handlers):
        root.addHandler(handler)


