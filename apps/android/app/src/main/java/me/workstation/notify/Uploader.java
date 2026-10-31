package me.workstation.notify;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 队列上传器。
 *
 * 为什么不用 WorkManager：本 APK 刻意零第三方依赖（连 AndroidX 都不引），
 * 以便用 aapt2 + javac + d8 手工构建、无需 Gradle 下载依赖。
 * 重试由 AlarmManager 调度，功能等价且完全可控。
 */
public final class Uploader {
    private static final String TAG = "WsNotify";
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();

    private Uploader() {}

    /** 异步触发一次刷队列。 */
    public static void flushAsync(Context ctx) {
        final Context app = ctx.getApplicationContext();
        POOL.execute(new Runnable() {
            @Override
            public void run() {
                flush(app);
            }
        });
    }

    /** 同步刷队列：把所有到期记录发出去，失败的排退避。 */
    public static void flush(Context ctx) {
        Queue q = new Queue(ctx);
        try {
            int guard = 0;
            while (guard++ < 200) {
                Queue.Row row = q.nextDue(System.currentTimeMillis());
                if (row == null) break;

                Api.Result r = Api.sendNotification(ctx, row);
                if (r == Api.Result.DONE) {
                    q.delete(row.id);
                } else if (r == Api.Result.NOT_CONFIGURED) {
                    // 未配置服务器：不删也不疯狂重试，等用户配置后手动刷
                    break;
                } else {
                    q.reschedule(row.id, row.attempts);
                    break;
                }
            }

            int left = q.pendingCount();
            if (left > 0) {
                scheduleRetry(ctx, 30_000L);
            }
        } finally {
            q.close();
        }
    }

    /** 用 AlarmManager 排一次重试。 */
    public static void scheduleRetry(Context ctx, long delayMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent i = new Intent(ctx, RetryReceiver.class);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getBroadcast(ctx, 0, i, flags);

        long at = System.currentTimeMillis() + delayMs;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Throwable t) {
            Log.w(TAG, "排重试失败：" + t);
        }
    }

    /**
     * 刷队列 + 拉配置 + 心跳。SetupActivity 打开时调用。
     *
     * 顺序很重要：先刷队列（更新 sentTotal / 清空待发），
     * 再发心跳——否则心跳上报的 sentTotal 和 queueDepth 都是旧值，
     * 页面上会显示「已上报 0 条」但账单里已经有记录了。
     */
    public static void housekeepingAsync(final Context ctx) {
        final Context app = ctx.getApplicationContext();
        POOL.execute(new Runnable() {
            @Override
            public void run() {
                String server = Config.server(app);
                if (!server.isEmpty()) {
                    // 队列非空时先尝试上传
                    flush(app);
                }

                Queue q = new Queue(app);
                int depth;
                try {
                    depth = q.pendingCount();
                } finally {
                    q.close();
                }

                Api.pullConfig(app);
                Api.heartbeat(app, depth);
            }
        });
    }
}
