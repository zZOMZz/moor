export interface Identity {
  owner: string | null;
  needsSetup: boolean;
  localOnly?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public rejected = false,
  ) {
    super(message);
  }
}
export async function api(path: string, body?: unknown) {
  const r = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 10000 : 45000),
  }).catch(() => {
    throw new ApiError('中转服务暂不可达，草稿和待确认请求已保留。', 0);
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error, r.status, data.rejected === true);
  return data;
}
