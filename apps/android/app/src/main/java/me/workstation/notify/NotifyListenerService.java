package me.workstation.notify;

import android.app.Notification;
import android.content.ComponentName;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;

/**
 * 通知监听：系统级入口。
 *
 * 权限：用户必须在「设置 → 通知使用权」里手动授予（BIND_NOTIFICATION_LISTENER_SERVICE
 * 无法通过运行时权限弹窗获取）。SetupActivity 负责引导。
 *
 * 隐私边界（用户拍板）：白名单可服务端下发、手机端执行过滤。
 * 非白名单 App 的通知在这里直接 return，根本不会进入队列、更不会上传。
 */
public class NotifyListenerService extends NotificationListenerService {
    private static final String TAG = "WsNotify";

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Throwable t) {
            // 监听服务里抛异常会被系统杀掉，必须全兜住
            Log.w(TAG, "处理通知失败：" + t);
        }
    }

    private void handle(StatusBarNotification sbn) {
        if (sbn == null) return;

        String pkg = sbn.getPackageName();
        String channel = Config.channelOf(this, pkg);
        // 白名单外：直接丢弃，不上传、不入队
        if (channel == null) return;
        if (!Config.enabled(this)) return;

        Notification n = sbn.getNotification();
        if (n == null) return;

        String title = "";
        String body = "";

        Bundle extras = n.extras;
        if (extras != null) {
            CharSequence t = extras.getCharSequence(Notification.EXTRA_TITLE);
            CharSequence b = extras.getCharSequence(Notification.EXTRA_TEXT);
            if (t != null) title = t.toString();
            if (b != null) body = b.toString();

            // 部分 App 把正文放在 BIG_TEXT 或 subText
            if (body.isEmpty()) {
                CharSequence big = extras.getCharSequence(Notification.EXTRA_BIG_TEXT);
                if (big != null) body = big.toString();
            }
            if (body.isEmpty()) {
                CharSequence sub = extras.getCharSequence(Notification.EXTRA_SUB_TEXT);
                if (sub != null) body = sub.toString();
            }
        }

        if (title.isEmpty() && body.isEmpty()) return;

        long postTime = sbn.getPostTime();
        if (postTime <= 0) postTime = System.currentTimeMillis();

        // 落本地持久队列：断网也不丢，进程被杀也不丢
        Queue q = new Queue(this);
        try {
            q.enqueue(pkg, channel, title, body, postTime);
        } finally {
            q.close();
        }

        Log.i(TAG, "入队 [" + channel + "] " + title + " / " + body);

        // 立即尝试上传；失败留给重试机制
        Uploader.flushAsync(this);
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        // 不关心移除事件
    }

    /** 供 SetupActivity 检查是否已授予通知使用权。 */
    public static boolean isEnabled(android.content.Context ctx) {
        String flat = android.provider.Settings.Secure.getString(
                ctx.getContentResolver(), "enabled_notification_listeners");
        if (flat == null || flat.isEmpty()) return false;
        String me = new ComponentName(ctx, NotifyListenerService.class).flattenToString();
        String meShort = new ComponentName(ctx, NotifyListenerService.class).flattenToShortString();
        return flat.contains(me) || flat.contains(meShort);
    }
}
