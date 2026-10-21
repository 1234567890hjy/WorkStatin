#!/usr/bin/env python3
"""用真实 SQLite 验证 D1 迁移脚本能否被接受。

沙箱禁止 wrangler 起本地 D1，所以这里用标准库 sqlite3 跑一遍迁移，
确认 SQL 语法、约束、种子数据都对 —— 这是对 D1 兼容性的最强静态验证。
"""

import sqlite3
import sys
from pathlib import Path

# Windows 控制台默认 GBK，强制 UTF-8 以正确输出中文与符号
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

MIGRATIONS = Path(__file__).resolve().parents[1] / "apps" / "worker" / "migrations"


def main() -> int:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print("❌ 没找到迁移脚本")
        return 1

    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")

    for f in files:
        sql = f.read_text(encoding="utf-8")
        try:
            conn.executescript(sql)
        except sqlite3.Error as e:
            print(f"❌ {f.name} 执行失败: {e}")
            return 1
        print(f"✅ {f.name} 执行成功")

    # 验证表结构
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    expected = {
        "user", "session", "login_attempt",
        "account", "category", "txn", "monthly_summary",
        "workout", "video_item", "task", "routine", "routine_log", "app_config",
    }
    missing = expected - tables
    if missing:
        print(f"❌ 缺少表: {sorted(missing)}")
        return 1
    print(f"✅ 表齐全：{len(tables)} 张")

    # 验证种子数据
    accounts = conn.execute("SELECT COUNT(*) FROM account").fetchone()[0]
    cats = conn.execute("SELECT COUNT(*) FROM category").fetchone()[0]
    if accounts < 4:
        print(f"❌ 账户种子不足: {accounts}")
        return 1
    if cats < 12:
        print(f"❌ 分类种子不足: {cats}")
        return 1
    print(f"✅ 种子数据：{accounts} 个账户 / {cats} 个分类")

    # 验证金额约束真的生效（负数应被拒绝）
    conn.execute("INSERT INTO account (name, kind) VALUES ('测试账户', 'cash')")
    acc_id = conn.execute("SELECT id FROM account WHERE name='测试账户'").fetchone()[0]
    try:
        conn.execute(
            "INSERT INTO txn (type, amount_cents, account_id, occurred_at, occurred_day, occurred_month)"
            " VALUES ('expense', -100, ?, '2026-10-21T10:00:00+08:00', '2026-10-21', '2026-10')",
            (acc_id,),
        )
        print("❌ 负金额竟然被接受，CHECK 约束失效")
        return 1
    except sqlite3.IntegrityError:
        print("✅ 负金额被 CHECK 约束拒绝")

    # 验证非法 type 被拒绝
    try:
        conn.execute(
            "INSERT INTO txn (type, amount_cents, account_id, occurred_at, occurred_day, occurred_month)"
            " VALUES ('bogus', 100, ?, '2026-10-21T10:00:00+08:00', '2026-10-21', '2026-10')",
            (acc_id,),
        )
        print("❌ 非法 type 竟然被接受")
        return 1
    except sqlite3.IntegrityError:
        print("✅ 非法 type 被 CHECK 约束拒绝")

    # 验证正常插入 + 汇总查询
    conn.execute(
        "INSERT INTO txn (type, amount_cents, account_id, category_id, occurred_at, occurred_day, occurred_month)"
        " VALUES ('expense', 1234, ?, 1, '2026-10-21T10:00:00+08:00', '2026-10-21', '2026-10')",
        (acc_id,),
    )
    total = conn.execute(
        "SELECT SUM(amount_cents) FROM txn WHERE occurred_month='2026-10' AND deleted_at IS NULL"
    ).fetchone()[0]
    if total != 1234:
        print(f"❌ 汇总结果错误: {total}")
        return 1
    print(f"✅ 插入与汇总正确: {total} 分")

    # 验证 monthly_summary 的重算 SQL（与 db.ts 中一致）
    conn.execute("DELETE FROM monthly_summary WHERE month = ?", ("2026-10",))
    conn.execute(
        """INSERT INTO monthly_summary (month, kind, category_id, total_cents, txn_count, updated_at)
           SELECT occurred_month, type, category_id, SUM(amount_cents), COUNT(*), datetime('now')
           FROM txn
           WHERE deleted_at IS NULL AND occurred_month = ?
           GROUP BY occurred_month, type, category_id""",
        ("2026-10",),
    )
    rows = conn.execute(
        "SELECT month, kind, category_id, total_cents, txn_count FROM monthly_summary"
    ).fetchall()
    if not rows or rows[0][3] != 1234:
        print(f"❌ monthly_summary 重算错误: {rows}")
        return 1
    print(f"✅ monthly_summary 写时重算正确: {rows}")

    conn.close()
    print("\n" + "=" * 50)
    print("✅ D1 迁移脚本通过真实 SQLite 验证")
    return 0


if __name__ == "__main__":
    sys.exit(main())
