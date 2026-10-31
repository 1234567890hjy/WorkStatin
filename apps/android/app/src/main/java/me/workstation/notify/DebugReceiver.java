package me.workstation.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 调试入口：通过 adb 广播注入一条假通知，验证整条链路。
 *
 * 用法（不需要点 UI，便于自动化验证）：
 *   adb shell am broadcast -a me.workstation.notify.DEBUG_INJECT \
 *     -e pkg com.tencent.mm -e title 微信支付 -e body '已支付¥16.88'
 *
 * 安全：只有 debuggable 的包才应该暴露；生产包不注册此 receiver。
 * 这里通过 Config 里的开关二次保护（默认仅当包为 debug 时生效）。
 */
public class DebugReceiver extends BroadcastReceiver {
    private static final String TAG = "WsNotify";
    public static final String ACTION = "me.workstation.notify.DEBUG_INJECT";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;

        // 只在可调试包上生效：BuildConfig 不可用（无 Gradle），
        // 用 ApplicationInfo.FLAG_DEBUGGABLE 判断。
        boolean debuggable =
                (ctx.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) {
            Log.w(TAG, "非调试包，忽略注入");
            return;
        }

        String pkg = intent.getStringExtra("pkg");
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");

        // adb shell 传中文时会被 Windows/adb 按 GBK 转码，服务端收到乱码。
        // 因此支持 base64 参数：-e title_b64 <base64(utf8)>
        String titleB64 = intent.getStringExtra("title_b64");
        String bodyB64 = intent.getStringExtra("body_b64");
        if (titleB64 != null) {
            try {
                title = new String(android.util.Base64.decode(titleB64, android.util.Base64.DEFAULT), "UTF-8");
            } catch (Exception e) {
                Log.w(TAG, "title_b64 解码失败");
            }
        }
        if (bodyB64 != null) {
            try {
                body = new String(android.util.Base64.decode(bodyB64, android.util.Base64.DEFAULT), "UTF-8");
            } catch (Exception e) {
                Log.w(TAG, "body_b64 解码失败");
            }
        }

        if (pkg == null) pkg = "com.tencent.mm";

        String channel = Config.channelOf(ctx, pkg);
        if (channel == null) {
            // 注入的包名不在白名单时，按 pkg 猜一个渠道，方便测试
            channel = pkg.contains("alipay") || pkg.contains("Alipay") ? "alipay"
                    : pkg.contains("icbc") || pkg.contains("bank") ? "bank" : "wechat";
        }

        Queue q = new Queue(ctx);
        try {
            q.enqueue(pkg, channel, title == null ? "" : title,
                    body == null ? "" : body, System.currentTimeMillis());
        } finally {
            q.close();
        }

        Log.i(TAG, "调试注入 [" + channel + "] " + title + " / " + body);
        Uploader.flushAsync(ctx);
    }
}
