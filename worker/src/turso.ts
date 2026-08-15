export interface TursoConfig {
  url: string;
  authToken: string;
}

export interface Stats {
  total: number;
  last24h: number;
}

async function execute(config: TursoConfig, statements: { sql: string; args?: number[] }[]): Promise<any> {
  const response = await fetch(`${config.url}/v2/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.authToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        ...statements.map((stmt) => ({
          type: "execute",
          stmt: { sql: stmt.sql, args: (stmt.args || []).map((value) => ({ type: "integer", value: String(value) })) },
        })),
        { type: "close" },
      ],
    }),
  });
  if (!response.ok) throw new Error(`turso responded ${response.status}`);
  return response.json();
}

function extractScalar(result: any, index: number): number {
  const row = result?.results?.[index]?.response?.result?.rows?.[0]?.[0];
  return Number(row?.value ?? 0) || 0;
}

export async function recordSuccess(config: TursoConfig, count: number): Promise<void> {
  if (count <= 0) return;
  await execute(config, [{ sql: "INSERT INTO translation_stats (count, created_at) VALUES (?, ?)", args: [count, Date.now()] }]);
}

export async function readStats(config: TursoConfig): Promise<Stats> {
  const dayAgo = Date.now() - 86_400_000;
  const result = await execute(config, [
    { sql: "SELECT COALESCE(SUM(count),0) FROM translation_stats" },
    { sql: "SELECT COALESCE(SUM(count),0) FROM translation_stats WHERE created_at > ?", args: [dayAgo] },
  ]);
  return { total: extractScalar(result, 0), last24h: extractScalar(result, 1) };
}
