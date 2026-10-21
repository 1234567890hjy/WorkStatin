import { Hono } from 'hono';
import type { Env } from './types.ts';
import { authRoutes } from './routes/auth.ts';
import { txnRoutes } from './routes/txn.ts';
import { metaRoutes } from './routes/meta.ts';
import { shareRoutes } from './routes/share.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { err } from './http.ts';

const app = new Hono<{ Bindings: Env }>();

// 健康检查
app.get('/api/health', (c) => c.json({ ok: true, data: { status: 'up' } }));

app.route('/api/auth', authRoutes);
app.route('/api/txns', txnRoutes);
app.route('/api', metaRoutes);
app.route('/api/share', shareRoutes);
app.route('/api/dashboard', dashboardRoutes);

app.notFound((c) => err('NOT_FOUND', `未找到路由 ${c.req.path}`, 404));

app.onError((e, c) => {
  console.error('unhandled', e);
  return err('INTERNAL', '服务器内部错误', 500);
});

export default app;
