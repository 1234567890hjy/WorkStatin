import { Hono } from 'hono';
import type { Env } from './types.ts';
import { authRoutes } from './routes/auth.ts';
import { txnRoutes } from './routes/txn.ts';
import { metaRoutes } from './routes/meta.ts';
import { shareRoutes } from './routes/share.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { workoutRoutes } from './routes/workout.ts';
import { weatherRoutes } from './routes/weather.ts';
import { videoRoutes } from './routes/video.ts';
import { llmRoutes } from './routes/llm.ts';
import { taskRoutes } from './routes/task.ts';
import { routineRoutes } from './routes/routine.ts';
import { searchRoutes } from './routes/search.ts';
import { notifyRoutes } from './routes/notify.ts';
import { devRoutes } from './routes/dev.ts';
import { err } from './http.ts';

const app = new Hono<{ Bindings: Env }>();

// 健康检查
app.get('/api/health', (c) => c.json({ ok: true, data: { status: 'up' } }));

app.route('/api/auth', authRoutes);
app.route('/api/txns', txnRoutes);
app.route('/api', metaRoutes);
app.route('/api/share', shareRoutes);
app.route('/api/dashboard', dashboardRoutes);

// ---- P1 ----
app.route('/api/workouts', workoutRoutes);
app.route('/api/weather', weatherRoutes);
app.route('/api/videos', videoRoutes);
app.route('/api/llm', llmRoutes);
app.route('/api/tasks', taskRoutes);
app.route('/api/routines', routineRoutes);
app.route('/api/search', searchRoutes);

// ---- 通知自动记账（APK 上报）----
app.route('/api/notify', notifyRoutes);

// ---- 本地开发初始化（生产环境自动 404）----
app.route('/api/dev', devRoutes);

app.notFound((c) => err('NOT_FOUND', `未找到路由 ${c.req.path}`, 404));

app.onError((e, c) => {
  console.error('unhandled', e);
  return err('INTERNAL', '服务器内部错误', 500);
});

export default app;
