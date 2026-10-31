package me.workstation.notify;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

/**
 * 本地持久上传队列。
 *
 * 为什么需要它：用户拍板「断网恢复后不丢不重」。
 * 手机在电梯/地铁里收到扣款通知时没有网络，通知必须先在本地落盘，
 * 等有网再补传。进程被杀、手机重启都不能丢。
 *
 * 用框架自带的 SQLiteOpenHelper，不引入任何第三方依赖。
 */
public final class Queue extends SQLiteOpenHelper {
    private static final String DB = "ws_notify_queue.db";
    private static final int VERSION = 1;
    private static final String TABLE = "outbox";

    public Queue(Context ctx) {
        super(ctx.getApplicationContext(), DB, null, VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE " + TABLE + " (" +
            "  id INTEGER PRIMARY KEY AUTOINCREMENT," +
            "  pkg TEXT," +
            "  channel TEXT," +
            "  title TEXT," +
            "  body TEXT," +
            "  post_time INTEGER," +
            "  created_at INTEGER NOT NULL," +
            "  attempts INTEGER NOT NULL DEFAULT 0," +
            "  next_try_at INTEGER NOT NULL DEFAULT 0" +
            ")");
        db.execSQL("CREATE INDEX idx_outbox_try ON " + TABLE + "(next_try_at)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldV, int newV) {
        // 单表、无历史包袱：直接重建比写迁移更安全
        db.execSQL("DROP TABLE IF EXISTS " + TABLE);
        onCreate(db);
    }

    /** 入队一条通知。返回行 id。 */
    public long enqueue(String pkg, String channel, String title, String body, long postTime) {
        ContentValues v = new ContentValues();
        v.put("pkg", pkg);
        v.put("channel", channel);
        v.put("title", title);
        v.put("body", body);
        v.put("post_time", postTime);
        v.put("created_at", System.currentTimeMillis());
        v.put("attempts", 0);
        v.put("next_try_at", 0);
        return getWritableDatabase().insert(TABLE, null, v);
    }

    public int pendingCount() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + TABLE, null);
        try {
            return c.moveToFirst() ? c.getInt(0) : 0;
        } finally {
            c.close();
        }
    }

    /**
     * 取一条到期的待发送记录。
     * 到期 = next_try_at <= now（指数退避后才会再次到期）。
     */
    public Row nextDue(long nowMs) {
        Cursor c = getReadableDatabase().rawQuery(
            "SELECT id, pkg, channel, title, body, post_time, attempts FROM " + TABLE +
            " WHERE next_try_at <= ? ORDER BY id ASC LIMIT 1",
            new String[] { String.valueOf(nowMs) });
        try {
            if (!c.moveToFirst()) return null;
            Row r = new Row();
            r.id = c.getLong(0);
            r.pkg = c.getString(1);
            r.channel = c.getString(2);
            r.title = c.getString(3);
            r.body = c.getString(4);
            r.postTime = c.getLong(5);
            r.attempts = c.getInt(6);
            return r;
        } finally {
            c.close();
        }
    }

    public void delete(long id) {
        getWritableDatabase().delete(TABLE, "id = ?", new String[] { String.valueOf(id) });
    }

    /**
     * 指数退避：10s → 30s → 2min → 10min → 30min，封顶 30 分钟。
     * 避免断网时疯狂重试耗电，也避免退避太慢导致恢复网络后迟迟不补传。
     */
    public void reschedule(long id, int attempts) {
        long[] backoff = { 10_000L, 30_000L, 120_000L, 600_000L, 1_800_000L };
        int idx = Math.min(attempts, backoff.length - 1);
        long next = System.currentTimeMillis() + backoff[idx];

        ContentValues v = new ContentValues();
        v.put("attempts", attempts + 1);
        v.put("next_try_at", next);
        getWritableDatabase().update(TABLE, v, "id = ?", new String[] { String.valueOf(id) });
    }

    public static final class Row {
        public long id;
        public String pkg;
        public String channel;
        public String title;
        public String body;
        public long postTime;
        public int attempts;
    }
}
