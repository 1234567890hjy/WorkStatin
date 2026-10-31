package me.workstation.notify;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 与 Worker 通信。
 *
 * 鉴权（用户拍板）：复用现有 session 登录。
 *   - SetupActivity 里用账号密码 POST /api/auth/login 拿 token
 *   - token 存 SharedPreferences
 *   - 收到 401 时自动用内置口令重登一次再重试
 *
 * session 有效期 30 天，过期由本类静默续期，用户无感。
 */
public final class Api {
    private static final String TAG = "WsNotify";
    private static final int TIMEOUT_MS = 15_000;

    /** 上传结果，决定队列里的记录该删还是该退避。 */
    public enum Result {
        /** 服务端已处理（recorded/pending/raw/duplicate/rejected），可删 */
        DONE,
        /** 网络或服务端临时故障，需重试 */
        RETRY,
        /** 配置缺失（未登录/未设服务器），重试无意义但也不该丢 */
        NOT_CONFIGURED,
    }

    private Api() {}

    /**
     * 上报一条通知。
     *
     * @return Result 决定队列动作
     */
    public static Result sendNotification(Context ctx, Queue.Row row) {
        String server = Config.server(ctx);
        if (server.isEmpty()) {
            Log.w(TAG, "server 未配置，跳过上报");
            return Result.NOT_CONFIGURED;
        }

        try {
            JSONObject payload = new JSONObject();
            payload.put("pkg", row.pkg == null ? "" : row.pkg);
            payload.put("title", row.title == null ? "" : row.title);
            payload.put("body", row.body == null ? "" : row.body);
            payload.put("postTime", row.postTime);
            payload.put("deviceId", Config.deviceId(ctx));
            payload.put("appVersion", "1.0");

            Resp r = post(ctx, "/api/notify/receive", payload, true);
            if (r.unauthorized) {
                // session 过期：重登一次再试
                if (!relogin(ctx)) {
                    Log.w(TAG, "重登失败，需要用户在 App 里重新输入口令");
                    return Result.RETRY;
                }
                r = post(ctx, "/api/notify/receive", payload, true);
                if (r.unauthorized) return Result.RETRY;
            }

            if (r.code >= 200 && r.code < 300) {
                // 服务端已给出 action，无论 recorded/pending/raw/duplicate 都可删
                Config.bumpSent(ctx);
                return Result.DONE;
            }
            // 4xx（非 401）说明请求本身有问题，重试也没用，删掉避免堵塞队列
            if (r.code >= 400 && r.code < 500) {
                Log.w(TAG, "上报被拒 " + r.code + "：" + r.body);
                return Result.DONE;
            }
            return Result.RETRY;
        } catch (Exception e) {
            Log.w(TAG, "上报失败：" + e);
            return Result.RETRY;
        }
    }

    /** 心跳。失败无所谓，下次再来。 */
    public static boolean heartbeat(Context ctx, int queueDepth) {
        String server = Config.server(ctx);
        if (server.isEmpty()) return false;
        try {
            JSONObject p = new JSONObject();
            p.put("deviceId", Config.deviceId(ctx));
            p.put("appVersion", "1.0");
            p.put("sentTotal", Config.sentTotal(ctx));
            p.put("queueDepth", queueDepth);
            Resp r = post(ctx, "/api/notify/heartbeat", p, true);
            if (r.unauthorized && relogin(ctx)) {
                r = post(ctx, "/api/notify/heartbeat", p, true);
            }
            return r.code >= 200 && r.code < 300;
        } catch (Exception e) {
            Log.w(TAG, "心跳失败：" + e);
            return false;
        }
    }

    /** 拉白名单。 */
    public static void pullConfig(Context ctx) {
        String server = Config.server(ctx);
        if (server.isEmpty()) return;
        try {
            Resp r = get(ctx, "/api/notify/config", true);
            if (r.unauthorized && relogin(ctx)) r = get(ctx, "/api/notify/config", true);
            if (r.code < 200 || r.code >= 300) return;

            JSONObject data = new JSONObject(r.body).optJSONObject("data");
            if (data == null) return;
            JSONObject allow = data.optJSONObject("allowlist");
            if (allow == null) return;

            StringBuilder sb = new StringBuilder();
            java.util.Iterator<String> keys = allow.keys();
            while (keys.hasNext()) {
                String pkg = keys.next();
                String ch = allow.optString(pkg, "unknown");
                if (sb.length() > 0) sb.append(';');
                sb.append(pkg).append('=').append(ch);
            }
            if (sb.length() > 0) {
                Config.prefs(ctx).edit().putString(Config.K_ALLOWLIST, sb.toString()).apply();
                Log.i(TAG, "白名单已更新：" + sb);
            }
        } catch (Exception e) {
            Log.w(TAG, "拉配置失败：" + e);
        }
    }

    /** 用存下的账号密码登录，成功后写回 token。 */
    public static boolean relogin(Context ctx) {
        String server = Config.server(ctx);
        String user = Config.prefs(ctx).getString(Config.K_USER, "");
        String pass = Config.prefs(ctx).getString(Config.K_PASS, "");
        if (server.isEmpty() || user == null || user.isEmpty() || pass == null || pass.isEmpty()) {
            return false;
        }
        try {
            JSONObject p = new JSONObject();
            p.put("username", user);
            p.put("password", pass);
            Resp r = post(ctx, "/api/auth/login", p, false);
            if (r.code < 200 || r.code >= 300) {
                Log.w(TAG, "登录失败 " + r.code + "：" + r.body);
                return false;
            }
            JSONObject data = new JSONObject(r.body).optJSONObject("data");
            String token = data == null ? null : data.optString("token", null);
            if (token == null || token.isEmpty()) return false;
            Config.setToken(ctx, token);
            Log.i(TAG, "重新登录成功");
            return true;
        } catch (Exception e) {
            Log.w(TAG, "登录异常：" + e);
            return false;
        }
    }

    // ---------- HTTP 底层 ----------

    private static final class Resp {
        int code;
        String body = "";
        boolean unauthorized;
    }

    private static Resp post(Context ctx, String path, JSONObject payload, boolean auth)
            throws Exception {
        return request(ctx, "POST", path, payload.toString().getBytes(StandardCharsets.UTF_8), auth);
    }

    private static Resp get(Context ctx, String path, boolean auth) throws Exception {
        return request(ctx, "GET", path, null, auth);
    }

    private static Resp request(Context ctx, String method, String path, byte[] body, boolean auth)
            throws Exception {
        String base = Config.server(ctx);
        if (base.endsWith("/")) base = base.substring(0, base.length() - 1);

        HttpURLConnection conn = (HttpURLConnection) new URL(base + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");

        if (auth) {
            String token = Config.token(ctx);
            if (token != null && !token.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + token);
            }
        }
        if (body != null) {
            conn.setDoOutput(true);
            OutputStream os = conn.getOutputStream();
            try {
                os.write(body);
            } finally {
                os.close();
            }
        }

        Resp r = new Resp();
        r.code = conn.getResponseCode();
        r.unauthorized = r.code == 401;

        InputStream is = null;
        try {
            is = r.code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (is != null) r.body = readAll(is);
        } finally {
            if (is != null) is.close();
            conn.disconnect();
        }
        return r;
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        return new String(bos.toByteArray(), StandardCharsets.UTF_8);
    }
}
