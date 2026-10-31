#!/usr/bin/env python3
"""模拟器真实链路验证。

为什么用 Python：Windows 的 bash/adb 会把中文参数按 GBK 转码，
服务端收到乱码导致解析失败。这里统一用 base64 传中文，
APK 侧 DebugReceiver 负责解码。

用法：
  PYTHONIOENCODING=utf-8 python apps/android/e2e_device.py
"""

import base64
import json
import subprocess
import time
import urllib.request

SERIAL = "emulator-5554"
BASE = "http://127.0.0.1:8787"
PKG = "me.workstation.notify"


def adb(*args, **kw):
    cmd = ["adb", "-s", SERIAL] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def b64(s: str) -> str:
    return base64.b64encode(s.encode("utf-8")).decode("ascii")


def inject(pkg: str, title: str, body: str):
    """通过广播注入一条通知（显式组件，绕开 Android 8+ 后台广播限制）。"""
    return adb(
        "shell",
        "am broadcast -n %s/.DebugReceiver -a %s.DEBUG_INJECT "
        "-e pkg %s -e title_b64 %s -e body_b64 %s"
        % (PKG, PKG, pkg, b64(title), b64(body)),
    )


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
    print("=== 模拟器真实链路验证 ===\n")

    # 0. 环境准备
    print("[0] 环境准备")
    adb("reverse", "tcp:8787", "tcp:8787")
    adb("shell", "cmd", "notification", "allow_listener",
        "%s/%s.NotifyListenerService" % (PKG, PKG))
    granted = adb("shell", "settings", "get", "secure", "enabled_notification_listeners").stdout
    print("    通知使用权：", "已授予" if PKG in granted else "未授予")

    # 1. 写入配置
    prefs = (
        "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n"
        "<map>\n"
        '    <string name="server">http://127.0.0.1:8787</string>\n'
        '    <string name="user">demo</string>\n'
        '    <string name="pass">demo1234</string>\n'
        '    <boolean name="enabled" value="true" />\n'
        "</map>\n"
    )
    adb("shell", "am", "start", "-n", "%s/.SetupActivity" % PKG)
    time.sleep(3)
    p = subprocess.run(
        ["adb", "-s", SERIAL, "shell",
         "run-as %s sh -c 'mkdir -p shared_prefs && cat > shared_prefs/ws_notify.xml'" % PKG],
        input=prefs.encode("utf-8"), capture_output=True,
    )
    adb("shell", "am", "force-stop", PKG)
    time.sleep(1)
    adb("shell", "am", "start", "-n", "%s/.SetupActivity" % PKG)
    time.sleep(5)
    print("    配置已写入并重启")

    # 2. 服务端登录，拿基准数据
    st, r = api("POST", "/api/auth/login", {"username": "demo", "password": "demo1234"})
    assert st == 200, "服务端登录失败 %s %s" % (st, r)
    token = r["data"]["token"]
    st, before = api("GET", "/api/txns?limit=200", None, token)
    before_ids = {it["id"] for it in before["data"]["items"]}
    print("    服务端账单基线：%d 笔" % len(before_ids))

    # 3. 注入三类通知
    print("\n[1] 注入通知（经 APK → 队列 → HTTP → Worker）")
    adb("logcat", "-c")
    cases = [
        ("微信 支出", "com.tencent.mm", "微信支付", "已支付¥16.88", 1688, "expense"),
        ("支付宝 支出", "com.eg.android.AlipayGphone", "支付宝", "付款成功 ¥11.20", 1120, "expense"),
        ("微信 收入", "com.tencent.mm", "微信支付", "已收款¥88.00", 8800, "income"),
    ]
    for name, pkg, title, body, expect_cents, expect_type in cases:
        inject(pkg, title, body)
        print("    → %s" % name)
        time.sleep(2)

    # 4. 检查 APK 日志
    time.sleep(4)
    logs = adb("logcat", "-d", "-s", "WsNotify:*").stdout
    print("\n[2] APK 日志")
    for line in logs.splitlines():
        if "WsNotify" in line:
            print("    " + line.split("WsNotify:")[-1].strip())

    # 5. 检查服务端落库
    print("\n[3] 服务端落库结果")
    st, after = api("GET", "/api/txns?limit=200", None, token)
    new_items = [it for it in after["data"]["items"] if it["id"] not in before_ids]
    ok = 0
    for it in new_items:
        print(
            "    #%s %s %s分 账户=%s 分类=%s 商户=%s note=%s"
            % (it["id"], it["type"], it["amount_cents"],
               it.get("account_name"), it.get("category_name"),
               it.get("merchant"), it.get("note"))
        )
        ok += 1

    if ok == 0:
        print("    ❌ 没有任何新记录")
        return 1

    # 6. 校验
    print("\n[4] 校验")
    by_cents = {it["amount_cents"]: it for it in new_items}
    failures = []
    for name, _pkg, _t, _b, cents, typ in cases:
        it = by_cents.get(cents)
        if not it:
            failures.append("%s 没有落库（%d 分）" % (name, cents))
        elif it["type"] != typ:
            failures.append("%s 类型错：%s != %s" % (name, it["type"], typ))

    # 账户映射
    wx = by_cents.get(1688)
    if wx and wx.get("account_name") != "微信":
        failures.append("微信通知没落到「微信」账户，实际=%s" % wx.get("account_name"))
    ali = by_cents.get(1120)
    if ali and ali.get("account_name") != "支付宝":
        failures.append("支付宝通知没落到「支付宝」账户，实际=%s" % ali.get("account_name"))

    # 分类
    if wx and wx.get("category_name") != "其他":
        failures.append("支出分类不是「其他」，实际=%s" % wx.get("category_name"))
    inc = by_cents.get(8800)
    if inc and inc.get("category_name") != "其他收入":
        failures.append("收入分类不是「其他收入」，实际=%s" % inc.get("category_name"))

    # 幂等：再注入同一条（postTime 变了，应视为新的一笔）
    print("\n[5] 幂等/去重")
    inject("com.tencent.mm", "微信支付", "已支付¥50.00")
    time.sleep(3)
    inject("com.tencent.mm", "微信支付", "已支付¥50.00")
    time.sleep(4)
    st, dup = api("GET", "/api/txns?limit=200", None, token)
    fifty = [it for it in dup["data"]["items"]
             if it["id"] not in before_ids and it["amount_cents"] == 5000]
    print("    60 秒内连发两笔 ¥50.00 → 落库 %d 笔（应为 1，走跨渠道/同渠道去重）" % len(fifty))
    if len(fifty) != 1:
        failures.append("去重失效：¥50.00 落库 %d 笔" % len(fifty))

    # 7. 健康度
    print("\n[6] 健康度")
    st, health = api("GET", "/api/notify/health", None, token)
    d = health["data"]
    print("    healthy=%s 心跳=%s 自动记账=%d 笔 待确认=%d 未识别=%d"
          % (d["healthy"], d["heartbeat_age_hours"], d["notify_txn_total"],
             d["pending_count"], d["raw_new_count"]))
    if not d["device"]:
        failures.append("没有收到 APK 心跳")
    else:
        print("    设备：%s 已上报 %s 条" % (d["device"]["device_id"], d["device"]["sent_total"]))

    # 结果
    print("\n" + "=" * 50)
    if failures:
        print("❌ 失败 %d 项：" % len(failures))
        for f in failures:
            print("   - " + f)
        return 1
    print("✅ 模拟器真实链路全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
