"""Desktop software accounts with password hashing and revocable sessions."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

SESSION_TTL = 7 * 24 * 60 * 60
USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{4,32}$")


class AccountError(ValueError):
    pass


def _db(data_dir: Path) -> sqlite3.Connection:
    folder = Path(data_dir) / "security"
    folder.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(folder / "software_accounts.sqlite3"), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS software_accounts (
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ACTIVE', created_at REAL NOT NULL,
          updated_at REAL NOT NULL, last_login_at REAL
        );
        CREATE TABLE IF NOT EXISTS software_sessions (
          token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL,
          created_at REAL NOT NULL, expires_at REAL NOT NULL,
          revoked_at REAL, FOREIGN KEY(account_id) REFERENCES software_accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_software_sessions_account ON software_sessions(account_id);
    """)
    return conn


def _validate(username: str, password: str) -> tuple[str, str]:
    username, password = str(username or "").strip(), str(password or "")
    if not USERNAME_RE.fullmatch(username):
        raise AccountError("账号需为4至32位中文、字母、数字、横线或下划线")
    if len(password) < 8 or len(password) > 128:
        raise AccountError("密码需为8至128位")
    return username, password


def _hash_password(password: str, salt: bytes) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 310_000).hex()


def _public(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "username": row["username"], "status": row["status"],
            "createdAt": row["created_at"], "updatedAt": row["updated_at"],
            "lastLoginAt": row["last_login_at"]}


def register(data_dir: Path, username: str, password: str) -> dict:
    username, password = _validate(username, password)
    now, salt = time.time(), secrets.token_bytes(16)
    with closing(_db(data_dir)) as conn, conn:
        try:
            conn.execute("INSERT INTO software_accounts VALUES(?,?,?,?,?,?,?,?)",
                         (uuid.uuid4().hex, username, _hash_password(password, salt), salt.hex(),
                          "ACTIVE", now, now, None))
        except sqlite3.IntegrityError as exc:
            raise AccountError("该账号已注册，请直接登录") from exc
    return login(data_dir, username, password)


def login(data_dir: Path, username: str, password: str) -> dict:
    username, password = str(username or "").strip(), str(password or "")
    with closing(_db(data_dir)) as conn, conn:
        row = conn.execute("SELECT * FROM software_accounts WHERE username=?", (username,)).fetchone()
        valid = row and hmac.compare_digest(row["password_hash"], _hash_password(password, bytes.fromhex(row["password_salt"])))
        if not valid:
            raise AccountError("账号或密码不正确")
        if row["status"] != "ACTIVE":
            raise AccountError("该账号已被禁用，请联系管理员")
        token, now = secrets.token_urlsafe(48), time.time()
        conn.execute("UPDATE software_accounts SET last_login_at=?,updated_at=? WHERE id=?", (now, now, row["id"]))
        conn.execute("INSERT INTO software_sessions VALUES(?,?,?,?,NULL)",
                     (hashlib.sha256(token.encode()).hexdigest(), row["id"], now, now + SESSION_TTL))
        account = dict(_public(row)); account["lastLoginAt"] = now
    return {"token": token, "expiresAt": now + SESSION_TTL, "account": account}


def session(data_dir: Path, token: str) -> dict | None:
    token_hash, now = hashlib.sha256(str(token or "").encode()).hexdigest(), time.time()
    with closing(_db(data_dir)) as conn, conn:
        row = conn.execute("""SELECT a.* FROM software_sessions s JOIN software_accounts a ON a.id=s.account_id
          WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND a.status='ACTIVE'""",
                           (token_hash, now)).fetchone()
        return _public(row) if row else None


def logout(data_dir: Path, token: str) -> None:
    with closing(_db(data_dir)) as conn, conn:
        conn.execute("UPDATE software_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL",
                     (time.time(), hashlib.sha256(str(token or "").encode()).hexdigest()))


def list_accounts(data_dir: Path) -> list[dict]:
    with closing(_db(data_dir)) as conn, conn:
        return [_public(row) for row in conn.execute("SELECT * FROM software_accounts ORDER BY created_at DESC")]


def set_status(data_dir: Path, account_id: str, enabled: bool) -> None:
    now = time.time()
    with closing(_db(data_dir)) as conn, conn:
        cur = conn.execute("UPDATE software_accounts SET status=?,updated_at=? WHERE id=?",
                           ("ACTIVE" if enabled else "DISABLED", now, account_id))
        if not cur.rowcount: raise AccountError("账号不存在")
        if not enabled: conn.execute("UPDATE software_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL", (now, account_id))


def reset_password(data_dir: Path, account_id: str, password: str) -> None:
    if len(str(password or "")) < 8: raise AccountError("新密码至少需要8位")
    now, salt = time.time(), secrets.token_bytes(16)
    with closing(_db(data_dir)) as conn, conn:
        cur = conn.execute("UPDATE software_accounts SET password_hash=?,password_salt=?,updated_at=? WHERE id=?",
                           (_hash_password(str(password), salt), salt.hex(), now, account_id))
        if not cur.rowcount: raise AccountError("账号不存在")
        conn.execute("UPDATE software_sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL", (now, account_id))


def delete_account(data_dir: Path, account_id: str) -> None:
    with closing(_db(data_dir)) as conn, conn:
        conn.execute("DELETE FROM software_sessions WHERE account_id=?", (account_id,))
        cur = conn.execute("DELETE FROM software_accounts WHERE id=?", (account_id,))
        if not cur.rowcount: raise AccountError("账号不存在")
