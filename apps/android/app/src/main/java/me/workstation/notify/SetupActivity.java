package me.workstation.notify;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 设置页 + 状态页。
 *
 * 刻意不用 AndroidX / Material：本 APK 零第三方依赖，
 * 以便 aapt2 + javac + d8 手工构建，无需 Gradle。
 *
 * 页面上有一个「调试注入」区：在没有微信的模拟器上也能验证整条链路
 * （入队 → 上传 → 服务端解析 → 落库）。
 */
public class SetupActivity extends Activity {
    private TextView status;
    private EditText serverInput;
    private EditText userInput;
    private EditText passInput;

    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(16);
        root.setPadding(pad, pad, pad, pad);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);

        TextView title = new TextView(this);
        title.setText("工作台通知采集");
        title.setTextSize(20);
        root.addView(title);

        status = new TextView(this);
        status.setTextSize(13);
        status.setPadding(0, dp(8), 0, dp(8));
        root.addView(status);

        Button grant = new Button(this);
        grant.setText("① 授予通知使用权");
        grant.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                try {
                    startActivity(new Intent(
                            "android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"));
                } catch (Exception e) {
                    Toast.makeText(SetupActivity.this,
                            "请手动到 设置→通知使用权 里开启", Toast.LENGTH_LONG).show();
                }
            }
        });
        root.addView(grant);

        root.addView(label("服务器地址（如 https://xxx.workers.dev）"));
        serverInput = input(Config.server(this), InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(serverInput);

        root.addView(label("账号"));
        userInput = input(Config.prefs(this).getString(Config.K_USER, ""), InputType.TYPE_CLASS_TEXT);
        root.addView(userInput);

        root.addView(label("口令"));
        passInput = input(Config.prefs(this).getString(Config.K_PASS, ""),
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        root.addView(passInput);

        Button save = new Button(this);
        save.setText("② 保存并登录");
        save.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                saveAndLogin();
            }
        });
        root.addView(save);

        Button flush = new Button(this);
        flush.setText("③ 立即上传队列 + 心跳");
        flush.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Uploader.flushAsync(SetupActivity.this);
                Uploader.housekeepingAsync(SetupActivity.this);
                Toast.makeText(SetupActivity.this, "已触发", Toast.LENGTH_SHORT).show();
                ui.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        refresh();
                    }
                }, 1200);
            }
        });
        root.addView(flush);

        // ---------- 调试注入 ----------
        root.addView(label("调试注入（模拟器验证用，不需要微信）"));

        Button injectWechat = new Button(this);
        injectWechat.setText("注入：微信支付 已支付¥16.88");
        injectWechat.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                inject("com.tencent.mm", "微信支付", "已支付¥16.88");
            }
        });
        root.addView(injectWechat);

        Button injectAlipay = new Button(this);
        injectAlipay.setText("注入：支付宝 付款成功 ¥11.20");
        injectAlipay.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                inject("com.eg.android.AlipayGphone", "支付宝", "付款成功 ¥11.20");
            }
        });
        root.addView(injectAlipay);

        Button injectRaw = new Button(this);
        injectRaw.setText("注入：未识别通知（应进 raw 表）");
        injectRaw.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                inject("com.tencent.mm", "微信支付", "系统维护中，请稍后再试");
            }
        });
        root.addView(injectRaw);

        setContentView(scroll);
        refresh();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
        Uploader.housekeepingAsync(this);
    }

    private void inject(String pkg, String title, String body) {
        Queue q = new Queue(this);
        try {
            q.enqueue(pkg, Config.channelOf(this, pkg), title, body, System.currentTimeMillis());
        } finally {
            q.close();
        }
        Uploader.flushAsync(this);
        Toast.makeText(this, "已入队并上传", Toast.LENGTH_SHORT).show();
        ui.postDelayed(new Runnable() {
            @Override
            public void run() {
                refresh();
            }
        }, 1500);
    }

    private void saveAndLogin() {
        String server = serverInput.getText().toString().trim();
        String user = userInput.getText().toString().trim();
        String pass = passInput.getText().toString();

        if (server.isEmpty()) {
            Toast.makeText(this, "请填服务器地址", Toast.LENGTH_SHORT).show();
            return;
        }
        // 允许用户只填域名，自动补 https://
        if (!server.startsWith("http://") && !server.startsWith("https://")) {
            server = "https://" + server;
        }
        while (server.endsWith("/")) server = server.substring(0, server.length() - 1);

        Config.prefs(this).edit()
                .putString(Config.K_SERVER, server)
                .putString(Config.K_USER, user)
                .putString(Config.K_PASS, pass)
                .apply();

        final String fServer = server;
        new Thread(new Runnable() {
            @Override
            public void run() {
                boolean ok = Api.relogin(SetupActivity.this);
                final boolean fOk = ok;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(SetupActivity.this,
                                fOk ? "登录成功" : "登录失败，检查地址/账号/口令",
                                Toast.LENGTH_LONG).show();
                        if (fOk) Uploader.housekeepingAsync(SetupActivity.this);
                        refresh();
                    }
                });
            }
        }).start();
    }

    private void refresh() {
        boolean granted = NotifyListenerService.isEnabled(this);
        Queue q = new Queue(this);
        int depth;
        try {
            depth = q.pendingCount();
        } finally {
            q.close();
        }

        String token = Config.token(this);
        StringBuilder sb = new StringBuilder();
        sb.append("通知使用权：").append(granted ? "✅ 已授予" : "❌ 未授予").append('\n');
        sb.append("服务器：").append(Config.server(this).isEmpty() ? "（未设置）" : Config.server(this)).append('\n');
        sb.append("登录状态：").append(token == null ? "❌ 未登录" : "✅ 已登录").append('\n');
        sb.append("待上传队列：").append(depth).append(" 条\n");
        sb.append("已成功上报：").append(Config.sentTotal(this)).append(" 条\n");
        sb.append("设备 ID：").append(Config.deviceId(this)).append('\n');
        sb.append("白名单：").append(Config.allowlist(this));

        status.setText(sb.toString());
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(12);
        t.setPadding(0, dp(10), 0, dp(2));
        return t;
    }

    private EditText input(String value, int inputType) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setInputType(inputType);
        e.setSingleLine(true);
        return e;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }
}
