# -*- coding: utf-8 -*-
"""Analytics version constants for 发财888 strict-v2."""
from __future__ import annotations

import os

DATA_SCHEMA_VERSION = 2
ANALYTICS_ALGORITHM_VERSION = "strict-v2"
BIG_ROAD_ALGORITHM_VERSION = "big-road-v2"
PLAN_REPLAY_VERSION = "simple-plan-v2"

# Set by systemd/deploy: Environment=FACAI888_GIT_COMMIT=<sha> (SIREN_GIT_COMMIT legacy fallback)
GIT_COMMIT = str(os.environ.get("FACAI888_GIT_COMMIT") or os.environ.get("SIREN_GIT_COMMIT") or "").strip() or "unknown"

# Backtest cache TTL (seconds)
BACKTEST_CACHE_TTL = 6 * 3600
