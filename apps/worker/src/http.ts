/** 统一响应构造。 */
export function ok<T>(data: T): Response {
  return Response.json({ ok: true, data });
}

export function err(code: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

/** 从 Cookie 或 Authorization 头里取 token。 */
export function readToken(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;

  const cookie = req.headers.get('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === 'ws_session') return decodeURIComponent(rest.join('=')) || null;
  }
  return null;
}

/** 取客户端 IP（Cloudflare 会带 CF-Connecting-IP）。 */
export function clientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ??
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
