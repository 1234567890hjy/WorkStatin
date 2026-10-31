package me.workstation.notify;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 重试闹钟回调：AlarmManager 到点后刷一次队列。
 * 也处理开机自启（重排一次，避免重启后队列卡住）。
 */
public class RetryReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        Uploader.flushAsync(ctx);
    }
}
