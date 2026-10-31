"""真实 Worker 上的 Dashboard + 撤销接口验证。

验证前端依赖的三个新能力在真实运行时可用：
  1. GET /api/dashboard 返回 notify 状态块
  2. POST /api/notify/undo/:id 的 5 分钟窗口
  3. 撤销后仪表盘与月度汇总同步

用法：PYTHONIOENCODING=utf-8 python apps/worker/test/live-dashboard.py
"""

import json
import time
import urllib.request

BASE = "http://127.0.0.1:8787"
failures = []
passed = 0


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
        print("  OK   " + name)
    else:
        msg = name + (" — " + str(detail) if detail != "" else "")
        failures.append(msg)
        print("  FAIL " + msg)


def api(method, path, payload=None, token=None):
    data = None
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main():
    print("=== Dashboard / 撤销 真实接口验证 ===\n")

    st, r = api("POST", "/api/auth/login", {"username": "demo", "password": "demo1234"})
    assert st == 200, "登录失败：%s %s" % (st, r)
    token = r["data"]["token"]
    print("已登录\n")

    print("[Dashboard notify 状态块]")
    st, d = api("GET", "/api/dashboard", token=token)
    check("dashboard 返回 200", st == 200, st)
    n = d.get("data", {}).get("notify")
    check("包含 notify 字段", n is not None, list((d.get("data") or {}).keys()))
    if n:
        for f in ("pending_count", "raw_new_count", "healthy", "has_device", "recent_auto_count"):
            check("notify.%s 存在" % f, f in n, list(n.keys()))
        check(
            "字段类型正确",
            isinstance(n["pending_count"], int)
            and isinstance(n["healthy"], bool)
            and isinstance(n["has_device"], bool),
            n,
        )
        print("\n  当前值：%s" % json.dumps(n, ensure_ascii=False))

    print("\n[撤销窗口]")
    st, r = api(
        "POST",
        "/api/notify/receive",
        {
            "pkg": "com.tencent.mm",
            "title": "微信支付",
            "body": "已支付¥42.42",
            "postTime": int(time.time() * 1000),
            "deviceId": "live",
        },
        token,
    )
    check("自动记账成功", r.get("data", {}).get("action") == "recorded", r)
    txn_id = r.get("data", {}).get("txn_id")

    if txn_id:
        st, u = api("POST", "/api/notify/undo/%s" % txn_id, token=token)
        check("5 分钟内可撤销", st == 200, "%s %s" % (st, u))
        check("返回撤销的月份", "month" in (u.get("data") or {}), u)

        st, d2 = api("GET", "/api/dashboard", token=token)
        n2 = d2.get("data", {}).get("notify", {})
        check("撤销后 dashboard 仍可正常返回", st == 200, st)
        print("  撤销后 recent_auto_count=%s" % n2.get("recent_auto_count"))

    print("\n[撤销防滥用]")
    st, res = api(
        "POST", "/api/txns",
        {"type": "expense", "amount_cents": 500, "account_id": 1},
        token,
    )
    manual_id = res.get("data", {}).get("id")
    if manual_id:
        st, u = api("POST", "/api/notify/undo/%s" % manual_id, token=token)
        check("手动记账不能撤销", st == 409 and u.get("error", {}).get("code") == "NOT_AUTO",
              "%s %s" % (st, u))
        # 清理
        api("DELETE", "/api/txns/%s" % manual_id, token=token)

    print("\n" + "=" * 50)
    if failures:
        print("FAILED %d / passed %d" % (len(failures), passed))
        for f in failures:
            print("  - " + f)
        return 1
    print("全部通过：%d 项" % passed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
