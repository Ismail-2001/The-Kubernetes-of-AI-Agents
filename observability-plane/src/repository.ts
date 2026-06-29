import { Pool, PoolClient } from "pg";

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceName: string;
  operationName: string;
  namespace: string;
  startTime: Date;
  endTime: Date | null;
  status: string;
  attributes: Record<string, unknown>;
  events: unknown[];
}

interface ReplaySession {
  id: string;
  traceId: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
  spans: Span[];
}

interface PaginatedTraces {
  traces: Span[][];
  nextCursor: Date | null;
}

export class ObservabilityRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async ingestSpan(span: Span): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO spans (trace_id, span_id, parent_span_id, service_name, operation_name,
                          namespace, start_time, end_time, status, attributes, events)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
       ON CONFLICT (span_id) DO NOTHING`,
      [
        span.traceId,
        span.spanId,
        span.parentSpanId,
        span.serviceName,
        span.operationName,
        span.namespace,
        span.startTime,
        span.endTime,
        span.status,
        JSON.stringify(span.attributes),
        JSON.stringify(span.events),
      ]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getTrace(traceId: string, namespace: string): Promise<Span[]> {
    const result = await this.pool.query(
      `SELECT trace_id, span_id, parent_span_id, service_name, operation_name,
              namespace, start_time, end_time, status, attributes, events
       FROM spans
       WHERE trace_id = $1 AND namespace = $2
       ORDER BY start_time ASC`,
      [traceId, namespace]
    );

    return result.rows.map((row) => this.mapRow(row));
  }

  async listTraces(
    namespace: string,
    from: Date,
    to: Date,
    limit: number = 50,
    cursor?: Date
  ): Promise<PaginatedTraces> {
    let query: string;
    let params: unknown[];

    if (cursor) {
      query = `SELECT trace_id, span_id, parent_span_id, service_name, operation_name,
                      namespace, start_time, end_time, status, attributes, events
               FROM spans
               WHERE namespace = $1
                 AND start_time >= $2
                 AND start_time <= $3
                 AND start_time < $4
               ORDER BY start_time DESC
               LIMIT $5`;
      params = [namespace, from, to, cursor, limit + 1];
    } else {
      query = `SELECT trace_id, span_id, parent_span_id, service_name, operation_name,
                      namespace, start_time, end_time, status, attributes, events
               FROM spans
               WHERE namespace = $1
                 AND start_time >= $2
                 AND start_time <= $3
               ORDER BY start_time DESC
               LIMIT $4`;
      params = [namespace, from, to, limit + 1];
    }

    const result = await this.pool.query(query, params);

    const rows = result.rows.map((row) => this.mapRow(row));
    const hasMore = rows.length > limit;
    const traces = hasMore ? rows.slice(0, limit) : rows;

    const traceGroups = new Map<string, Span[]>();
    for (const span of traces) {
      const group = traceGroups.get(span.traceId) ?? [];
      group.push(span);
      traceGroups.set(span.traceId, group);
    }

    const nextCursor = hasMore && traces.length > 0
      ? traces[traces.length - 1]!.startTime
      : null;

    return {
      traces: Array.from(traceGroups.values()),
      nextCursor,
    };
  }

  async getReplaySession(sessionId: string, namespace?: string): Promise<ReplaySession | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const sessionResult = await client.query(
        `SELECT id, trace_id, created_at, metadata
         FROM replay_sessions
         WHERE id = $1`,
        [sessionId]
      );

      if (sessionResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const session = sessionResult.rows[0]!;

      let spansQuery: string;
      let spansParams: unknown[];

      if (namespace) {
        spansQuery = `SELECT trace_id, span_id, parent_span_id, service_name, operation_name,
                namespace, start_time, end_time, status, attributes, events
         FROM spans
         WHERE trace_id = $1 AND namespace = $2
         ORDER BY start_time ASC`;
        spansParams = [session.trace_id as string, namespace];
      } else {
        spansQuery = `SELECT trace_id, span_id, parent_span_id, service_name, operation_name,
                namespace, start_time, end_time, status, attributes, events
         FROM spans
         WHERE trace_id = $1
         ORDER BY start_time ASC`;
        spansParams = [session.trace_id as string];
      }

      const spansResult = await client.query(spansQuery, spansParams);

      await client.query("COMMIT");

      return {
        id: session.id as string,
        traceId: session.trace_id as string,
        createdAt: session.created_at as Date,
        metadata: session.metadata as Record<string, unknown>,
        spans: spansResult.rows.map((row) => this.mapRow(row)),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async createReplaySession(
    traceId: string,
    metadata?: Record<string, unknown>
  ): Promise<ReplaySession> {
    const result = await this.pool.query(
      `INSERT INTO replay_sessions (trace_id, metadata)
       VALUES ($1, $2::jsonb)
       RETURNING id, trace_id, created_at, metadata`,
      [traceId, JSON.stringify(metadata ?? {})]
    );

    const row = result.rows[0]!;
    return {
      id: row.id as string,
      traceId: row.trace_id as string,
      createdAt: row.created_at as Date,
      metadata: row.metadata as Record<string, unknown>,
      spans: [],
    };
  }

  async batchIngest(spans: Span[]): Promise<number> {
    if (spans.length === 0) return 0;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const traceIds: string[] = [];
      const spanIds: string[] = [];
      const parentSpanIds: (string | null)[] = [];
      const serviceNames: string[] = [];
      const operationNames: string[] = [];
      const namespaces: string[] = [];
      const startTimes: Date[] = [];
      const endTimes: (Date | null)[] = [];
      const statuses: string[] = [];
      const attributes: string[] = [];
      const events: string[] = [];

      for (const span of spans) {
        traceIds.push(span.traceId);
        spanIds.push(span.spanId);
        parentSpanIds.push(span.parentSpanId);
        serviceNames.push(span.serviceName);
        operationNames.push(span.operationName);
        namespaces.push(span.namespace);
        startTimes.push(span.startTime);
        endTimes.push(span.endTime);
        statuses.push(span.status);
        attributes.push(JSON.stringify(span.attributes));
        events.push(JSON.stringify(span.events));
      }

      const result = await client.query(
        `INSERT INTO spans (trace_id, span_id, parent_span_id, service_name, operation_name,
                            namespace, start_time, end_time, status, attributes, events)
         SELECT unnest($1::varchar[]), unnest($2::varchar[]), unnest($3::varchar[]),
                unnest($4::varchar[]), unnest($5::varchar[]), unnest($6::varchar[]),
                unnest($7::timestamptz[]), unnest($8::timestamptz[]), unnest($9::varchar[]),
                unnest($10::jsonb[]), unnest($11::jsonb[])
         ON CONFLICT (span_id) DO NOTHING`,
        [
          traceIds,
          spanIds,
          parentSpanIds,
          serviceNames,
          operationNames,
          namespaces,
          startTimes,
          endTimes,
          statuses,
          attributes,
          events,
        ]
      );

      await client.query("COMMIT");

      return result.rowCount ?? 0;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteTrace(traceId: string, namespace: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM spans
       WHERE trace_id = $1 AND namespace = $2`,
      [traceId, namespace]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getTraceCost(traceId: string, namespace?: string): Promise<string> {
    let query: string;
    let params: unknown[];

    if (namespace) {
      query = `SELECT attributes->'fields'->'egaop.llm.cost'->>'stringValue' AS cost
       FROM spans
       WHERE trace_id = $1 AND namespace = $2
         AND attributes->'fields'->'egaop.llm.cost' IS NOT NULL
       ORDER BY start_time DESC
       LIMIT 1`;
      params = [traceId, namespace];
    } else {
      query = `SELECT attributes->'fields'->'egaop.llm.cost'->>'stringValue' AS cost
       FROM spans
       WHERE trace_id = $1
         AND attributes->'fields'->'egaop.llm.cost' IS NOT NULL
       ORDER BY start_time DESC
       LIMIT 1`;
      params = [traceId];
    }

    const result = await this.pool.query(query, params);

    return result.rows[0]?.cost ?? "$0.00";
  }

  private mapRow(row: Record<string, unknown>): Span {
    return {
      traceId: row.trace_id as string,
      spanId: row.span_id as string,
      parentSpanId: row.parent_span_id as string | null,
      serviceName: row.service_name as string,
      operationName: row.operation_name as string,
      namespace: row.namespace as string,
      startTime: row.start_time as Date,
      endTime: row.end_time as Date | null,
      status: row.status as string,
      attributes: row.attributes as Record<string, unknown>,
      events: row.events as unknown[],
    };
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
