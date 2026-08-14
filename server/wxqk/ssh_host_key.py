# -*- coding: utf-8 -*-
"""SSH host-key verification for production deploys (no AutoAddPolicy)."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any


def configure_ssh_client(client: Any) -> None:
    """Apply RejectPolicy + known_hosts or WXQK_SSH_HOST_KEY_SHA256 pin."""
    import paramiko

    known = os.environ.get("WXQK_SSH_KNOWN_HOSTS", "").strip()
    if known and Path(known).is_file():
        client.load_host_keys(known)
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        return

    expected_fp = os.environ.get("WXQK_SSH_HOST_KEY_SHA256", "").strip().lower()
    if not expected_fp:
        raise SystemExit(
            "DEPLOY_HOST_KEY_GATE: set WXQK_SSH_KNOWN_HOSTS or WXQK_SSH_HOST_KEY_SHA256 "
            "(AutoAddPolicy disabled)"
        )

    class FingerprintPolicy(paramiko.MissingHostKeyPolicy):
        def missing_host_key(self, client, hostname, key):  # noqa: N802
            sha = hashlib.sha256(key.asbytes()).hexdigest().lower()
            if sha != expected_fp and f"sha256:{sha}" != expected_fp:
                raise paramiko.SSHException(
                    f"host key mismatch for {hostname}: got sha256:{sha}"
                )
            client.get_host_keys().add(hostname, key.get_name(), key)

    client.set_missing_host_key_policy(FingerprintPolicy())
