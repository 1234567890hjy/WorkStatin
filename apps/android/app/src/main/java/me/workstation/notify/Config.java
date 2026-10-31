package me.workstation.notify;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 本地配置与凭证。
 *
 * 凭证处理（用户拍板）：
 *   - 首次安装后在 SetupActivity 里输入账号密码，存 SharedPreferences
 *   - 收到 401 自动用内置口令重登，拿新 session
 *   - 口令只存在手机本地，不进代码仓库
 */
public final class Config {
    private static final String PREF = "ws_notify";

    public static final String K_SERVER = "server";
    public static final String K_USER = "user";
    public static final String K_PASS = "pass";
    public static final String K_TOKEN = "token";
    public static final String K_ALLOWLIST = "allowlist";
    public static final String K_DEVICE = "device_id";
    public static final String K_ENABLED = "enabled";
    public static final String K_SENT = "sent_total";

    private Config() {}

    public static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public static String server(Context ctx) {
        String s = prefs(ctx).getString(K_SERVER, "");
        return s == null ? "" : s.trim();
    }

    public static String token(Context ctx) {
        return prefs(ctx).getString(K_TOKEN, null);
    }

    public static void setToken(Context ctx, String token) {
        prefs(ctx).edit().putString(K_TOKEN, token).apply();
    }

    public static boolean enabled(Context ctx) {
        return prefs(ctx).getBoolean(K_ENABLED, true);
    }

    /**
     * 白名单：包名 → 渠道。
     * 格式 "com.tencent.mm=wechat;com.eg.android.AlipayGphone=alipay"
     * 存成扁平字符串，避免 JSON 解析依赖。
     *
     * 默认值给微信和支付宝 —— 首次安装即可工作，
     * 之后服务端下发会覆盖。
     */
    public static String allowlist(Context ctx) {
        String v = prefs(ctx).getString(K_ALLOWLIST, null);
        if (v == null || v.isEmpty()) {
            return "com.tencent.mm=wechat;com.eg.android.AlipayGphone=alipay";
        }
        return v;
    }

    /** 包名在白名单里则返回渠道，否则返回 null。 */
    public static String channelOf(Context ctx, String pkg) {
        if (pkg == null) return null;
        for (String pair : allowlist(ctx).split(";")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            if (pair.substring(0, eq).trim().equals(pkg)) {
                return pair.substring(eq + 1).trim();
            }
        }
        return null;
    }

    public static String deviceId(Context ctx) {
        String v = prefs(ctx).getString(K_DEVICE, null);
        if (v == null || v.isEmpty()) {
            v = "android-" + Long.toHexString(System.currentTimeMillis());
            prefs(ctx).edit().putString(K_DEVICE, v).apply();
        }
        return v;
    }

    public static int sentTotal(Context ctx) {
        return prefs(ctx).getInt(K_SENT, 0);
    }

    public static void bumpSent(Context ctx) {
        // 用 commit() 而非 apply()：apply 是异步写盘，
        // 紧接着发心跳时会读到旧值，导致页面显示「已上报 0 条」
        // 而账单里明明已经有记录。计数是毫秒级操作，同步写可接受。
        prefs(ctx).edit().putInt(K_SENT, sentTotal(ctx) + 1).commit();
    }
}
