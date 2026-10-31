"""端到端联调：直接打真实运行中的 Worker（wrangler dev）。

为什么不用 curl：Windows 的 bash 会把中文参数按 GBK 编码传出去，
导致服务端收到乱码、解析必然失败。Python 显式 UTF-8 更可靠。
"""

import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8787"


def call(method, path, payload=None, token=None):
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
    print("=== 真实 Worker 联调 ===\n")

    # 登录
    st, r = call("POST", "/api/auth/login", {"username": "demo", "password": "demo1234"})
    assert st == 200, f"登录失败 {st} {r}"
    token = r["data"]["token"]
    print(f"✓ 登录成功 token={token[:12]}...")

    # 清掉之前 shell 乱码产生的脏数据（重新 bootstrap 会重建，这里不处理）

    cases = [
        ("微信 已支付¥16.88", "com.tencent.mm", "微信支付", "已支付¥16.88", "recorded"),
        ("微信 已支付¥15", "com.tencent.mm", "微信支付", "已支付¥15", "recorded"),
        ("支付宝 付款成功 ¥11.20", "com.eg.android.AlipayGphone", "支付宝", "付款成功 ¥11.20", "recorded"),
        ("微信 已收款¥88.00", "com.tencent.mm", "微信支付", "已收款¥88.00", "recorded"),
        ("微信 退款到账¥25.50", "com.tencent.mm", "微信支付", "退款到账¥25.50", "recorded"),
        ("微信 无法解析", "com.tencent.mm", "微信支付", "系统维护中，请稍后再试", "raw"),
    ]

    import time
    for name, pkg, title, body, expect in cases:
        st, r = call(
            "POST",
            "/api/notify/receive",
            {
                "pkg": pkg,
                "title": title,
                "body": body,
                "postTime": int(time.time() * 1000),
                "deviceId": "e2e-real",
            },
            token,
        )
        act = r.get("data", {}).get("action")
        ok = "✓" if act == expect else "✗"
        extra = ""
        if act == "recorded":
            extra = f" {r['data']['amount_cents']}分 type={r['data']['type']} 商户={r['data']['merchant']}"
        print(f"{ok} {name} → {act}{extra}  (期望 {expect})")

    # 健康度
    st, r = call("GET", "/api/notify/health", None, token)
    print(f"\n健康度：{json.dumps(r['data'], ensure_ascii=False)}")

    # 账单
    st, r = call("GET", "/api/txns?limit=10", None, token)
    items = r["data"]["items"]
    print(f"\n账单最近 {len(items)} 笔（source=notify 的）：")
    for it in items:
        if it.get("source") == "notify":
            print(
                f"  #{it['id']} {it['type']} {it['amount_cents']}分 "
                f"账户={it.get('account_name')} 分类={it.get('category_name')} "
                f"商户={it.get('merchant')} note={it.get('note')}"
            )


if __name__ == "__main__":
    main()
